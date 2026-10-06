const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const REGION_PREFIX = /^([a-z]{2}(?:-[a-z]+)+-\d+):(.*)$/i;

let ssmClients;
let ssmCache;
let defaultRegion;

const replaceExpression = /\{\{(early-resolve|early-resolve-with-default):ssm:([^|]*)(\|(.*))?\}\}/g;

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

function parseParameterAndRegion(ssmParameter) {
  const match = ssmParameter.match(REGION_PREFIX);
  if (match) {
    return { parameterName: match[2], region: match[1] };
  }
  return { parameterName: ssmParameter, region: undefined };
}

function getClient(region) {
  const key = region || '';
  if (!ssmClients[key]) {
    ssmClients[key] = region ? new SSMClient({ region }) : new SSMClient();
  }
  return ssmClients[key];
}

function cacheKey(parameter, region) {
  return `${region || ''}:${parameter}`;
}

async function getSSMParameter(parameter, region) {
  const key = cacheKey(parameter, region);
  if (key in ssmCache) {
    console.log('Using cached parameter', parameter, 'region', region || 'default');
  } else {
    let ret;
    try {
      if (process.env.TEST) {
        if (parameter.includes('default-resolve')) {
          throw new Error(`Could not find ${parameter} in SSM`);
        }
        ret = region ? `mocked@${region}` : 'mocked';
      } else {
        const rsp = await getClient(region).send(new GetParameterCommand({
          Name: parameter,
          WithDecryption: true
        }));
        ret = rsp.Parameter.Value;
      }
    } catch (e) {
      console.warn(e);
      throw new Error(`Failed to resolve param: ${parameter}${region ? ` (region ${region})` : ''}`);
    }
    ssmCache[key] = ret;
  }

  return ssmCache[key];
}

async function deepReplace(object, params) {
  if (object === null || typeof object === 'boolean' || typeof object === 'number') {
    return object;
  }

  if (typeof object === 'string') {
    return await asyncStringReplace(object, replaceExpression, async (match, resolveType, ssmParameter, pipe, defaultValue) => {
      try {
        const substituted = replaceParams(ssmParameter, params);
        const { parameterName, region: expressionRegion } = parseParameterAndRegion(substituted);
        const region = expressionRegion || defaultRegion;
        console.log("Resolving parameter:", match, ssmParameter, parameterName, "region", region || "default");
        return await getSSMParameter(parameterName, region);
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
    ssmClients = {};
    const macroParams = event["params"] || {};
    defaultRegion = macroParams.Region || undefined;

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
