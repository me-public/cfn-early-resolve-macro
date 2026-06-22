const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const client = new SSMClient();
let ssmCache;

const replaceExpression = /\{\{(early-resolve|early-resolve-with-default):ssm:([^|]*)(\|([^}]*))?\}\}/g;

// A slightly modified version of https://dev.to/ycmjason/stringprototypereplace-asynchronously-28k9
// without the Promise.all to not parallelize the SSM calls.
const asyncStringReplace = async (str, regex, aReplacer) => {
  const substrs = [];
  let match, i = 0;
  while ((match = regex.exec(str)) !== null) {
    substrs.push(str.slice(i, match.index));
    substrs.push(await aReplacer(...match));
    i = regex.lastIndex;
  }
  substrs.push(str.slice(i));
  return substrs.join('');
};

function replaceParams(str, params) {
  let replaced = str;
  for (const [key, value] of Object.entries(params)) {
    // Replace ${key} with value, for example ${Environment}
    replaced = replaced.replace(`\${${key}}`, value);
  }
  return replaced;
}

async function getSSMParameter(parameter) {
  if (parameter in ssmCache) {
    console.log('Using cached parameter', parameter);
  } else {
    let ret;
    try {
      if (process.env.TEST) {
        if (parameter.includes('default-resolve')) {
          throw new Error(`Could not find ${parameter} in SSM`);
        }
        ret = 'mocked';
      } else {
        const rsp = await client.send(new GetParameterCommand({
          Name: parameter,
          WithDecryption: true
        }));
        ret = rsp.Parameter.Value;
      }
    } catch (e) {
      console.warn(e);
      throw new Error(`Failed to resolve param: ${parameter}`);
    }
    ssmCache[parameter] = ret;
  }

  return ssmCache[parameter];
}

async function deepReplace(object, params) {
  if (object === null || typeof object === 'boolean' || typeof object === 'number') {
    return object;
  }

  if (typeof object === 'string') {
    return await asyncStringReplace(object, replaceExpression, async (match, resolveType, ssmParameter, pipe, defaultValue) => {
      try {
        const parameterName = replaceParams(ssmParameter, params);
        console.log("Resolving parameter:", match, ssmParameter, parameterName);
        return await getSSMParameter(parameterName);
      } catch (e) {
        if (resolveType === 'early-resolve-with-default') {
          return defaultValue || "";
        }
        throw e;
      }
    });
  }

  if (typeof object === 'object') { // Either array or object
    for (const key in object) {
      object[key] = await deepReplace(object[key], params);
    }
    return object;
  }

  return object;
}

exports.handler = async (event, context) => {
  try {
    ssmCache = {};

    console.log("Parsing event:", JSON.stringify(event));
    const template = event["fragment"] || {};
    const params = event["templateParameterValues"] || {};
    const resolvedTemplate = await deepReplace(template, params);

    return {
      requestId: event["requestId"],
      status: "success",
      fragment: resolvedTemplate,
    }
  } catch (e) {
    console.error(e);
    return {
      requestId: event["requestId"],
      status: "failure",
      errorMessage: e.message,
    }
  }
}
