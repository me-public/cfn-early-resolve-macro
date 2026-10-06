const { strict: assert } = require('assert');
const { handler } = require('./early-resolve');

process.env.TEST = true;

const baseTemplate = {
  "accountId": "1234567890",
  "fragment": {
    "AWSTemplateFormatVersion": "2010-09-09",
    "Description": "early-resolve-test",
    "Parameters": {
      "Environment": {
        "Type": "String"
      }
    },
    "Resources": {
      "SampleResource": {
        "Type": "AWS::None::Resource",
        "Properties": {
          "SimpleResolve": "{{early-resolve:ssm:/${Environment}/infra/sample-resolve}}",
          "DefaultResolve": "{{early-resolve-with-default:ssm:/${Environment}/infra/default-resolve|default}}",
          "DefaultResolveEmpty": "{{early-resolve-with-default:ssm:/${Environment}/infra/default-resolve}}",
          "ArrayResolve": [
            "partially-{{early-resolve:ssm:/${Environment}/infra/resource-arn}}"
          ],
          "ArrayMultiResolve": [
            {
              "Key": "melio:early-resolve-test-1",
              "Value": "multi-key-1-{{early-resolve:ssm:/${Environment}/infra/hello}}"
            },
            {
              "Key": "melio:early-resolve-test-2",
              "Value": "multi-key-2-{{early-resolve:ssm:/${Environment}/infra/hello}}"
            }
          ],
          "RegionOverride": "{{early-resolve:ssm:us-east-1:/${Environment}/infra/master-domain}}",
          "RegionOverrideWithDefault": "{{early-resolve-with-default:ssm:us-east-1:/${Environment}/infra/default-resolve|fallback}}"
        }
      }
    }
  },
  "transformId": "1234567890::EarlyResolve",
  "requestId": "b7af92d7-d0fd-4fb7-a5b5-614deb2c36be",
  "region": "eu-central-1",
  "params": {},
  "templateParameterValues": {
    "Environment": "sample-environment"
  }
};

async function run() {
  // Existing behavior without region arguments
  {
    const result = await handler(JSON.parse(JSON.stringify(baseTemplate)), {});
    const props = result.fragment.Resources.SampleResource.Properties;
    assert(props.SimpleResolve === 'mocked', 'Failed to resolve SimpleValue');
    assert(props.DefaultResolve === 'default', 'Failed to resolve default value');
    assert(props.DefaultResolveEmpty === '', 'Failed to resolve default empty value');
    assert(props.ArrayResolve[0] === 'partially-mocked', 'Failed to resolve array');
    assert(props.ArrayMultiResolve[0].Value === 'multi-key-1-mocked', 'Failed to resolve multi array 1');
    assert(props.ArrayMultiResolve[1].Value === 'multi-key-2-mocked', 'Failed to resolve multi array 2');
    assert(props.RegionOverride === 'mocked@us-east-1', 'Failed to resolve per-expression region override');
    assert(props.RegionOverrideWithDefault === 'fallback', 'Failed to resolve default with region override');
  }

  // Transform-level Region applies when expression has no region prefix
  {
    const withMacroRegion = JSON.parse(JSON.stringify(baseTemplate));
    withMacroRegion.params = { Region: 'us-east-1' };
    withMacroRegion.fragment.Resources.SampleResource.Properties = {
      FromMacro: "{{early-resolve:ssm:/${Environment}/infra/master-domain}}",
      ExpressionWins: "{{early-resolve:ssm:us-east-2:/${Environment}/infra/master-domain}}"
    };
    const result = await handler(withMacroRegion, {});
    const props = result.fragment.Resources.SampleResource.Properties;
    assert(props.FromMacro === 'mocked@us-east-1', 'Failed to apply Transform Region parameter');
    assert(props.ExpressionWins === 'mocked@us-east-2', 'Per-expression region should override Transform Region');
  }

  console.log('All tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
