// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as amplify_alpha from "@aws-cdk/aws-amplify-alpha";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as customResources from 'aws-cdk-lib/custom-resources';
import * as opensearch from "aws-cdk-lib/aws-opensearchservice"
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Duration } from "aws-cdk-lib";
import path = require("path");

export class BlogContentRepositorySearchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const path = require("path");
    const department_attribute_name = "department"; //sample attribute for resource access control

    //// BASE CONTENT REPOSITORY CAPABILITIES ////

    // create pre token generation Lambda to add and modify custom claims for the id token
    const pre_token_lambda = new lambda.Function(this, "pre-token-lambda", {
      code: lambda.Code.fromAsset("lambdas"),
      handler: "pre_token.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      runtime: lambda.Runtime.PYTHON_3_10,
    });

    // create the Cognito user pool
    const cognito_user_pool = new cognito.UserPool(this, "cognito-user-pool", {
      userPoolName: "content-repository-up",
      selfSignUpEnabled: false,
      signInAliases: {
        username: true,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      signInCaseSensitive: false,
      lambdaTriggers: {
        preTokenGeneration: pre_token_lambda
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const clientReadAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ emailVerified: true });

    // create the Cognito user pool client
    const cognito_user_pool_client = new cognito.UserPoolClient(
      this,
      "cognito-user-pool-client",
      {
        userPool: cognito_user_pool,
        authFlows: {
          adminUserPassword: true,
          custom: true,
          userSrp: true,
        },
        supportedIdentityProviders: [
          cognito.UserPoolClientIdentityProvider.COGNITO,
        ],
        readAttributes: clientReadAttributes,
      }
    );
    cognito_user_pool_client.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // create Cognito identity pool
    const cognito_identity_pool = new cognito.CfnIdentityPool(
      this,
      "cognito-identity-pool",
      {
        identityPoolName: "content-repository-ip",
        allowUnauthenticatedIdentities: false,
        cognitoIdentityProviders: [
          {
            clientId: cognito_user_pool_client.userPoolClientId,
            providerName: cognito_user_pool.userPoolProviderName,
          },
        ],
      }
    );
    cognito_identity_pool.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // create Principal Tag mappings in the identity pool after it has been created
    // requires a custom resource (https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources-readme.html)
    // uses the SDK, rather than CDK code, as attaching Principal Tags through CDK is currently not supported yet
    const principalTagParameters = {
      "IdentityPoolId": cognito_identity_pool.ref,
      "IdentityProviderName": cognito_user_pool.userPoolProviderName,
      "PrincipalTags": {
        "department": department_attribute_name,
        //"clearance": "clearance",
      },
      "UseDefaults": false
    }
    const setPrincipalTagAction = {
      action: "setPrincipalTagAttributeMap",
      service: "CognitoIdentity",
      parameters: principalTagParameters,
      physicalResourceId: customResources.PhysicalResourceId.of(cognito_identity_pool.ref)
    }
    new customResources.AwsCustomResource(this, 'custom-resource-principal-tags', {
      onCreate: setPrincipalTagAction,
      onUpdate: setPrincipalTagAction,
      policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [`arn:aws:cognito-identity:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:identitypool/${cognito_identity_pool.ref}`],
      }),
    })

    // create required default role for unauthenticated users (validated by CDK)
    const cognito_unauthenticated_role = new iam.Role(
      this,
      "cognito-unauthenticated-role",
      {
        description: "Default role for anonymous users",
        assumedBy: new iam.FederatedPrincipal(
          "cognito-identity.amazonaws.com",
          {
            StringEquals: {
              "cognito-identity.amazonaws.com:aud": cognito_identity_pool.ref,
            },
            "ForAnyValue:StringLike": {
              "cognito-identity.amazonaws.com:amr": "unauthenticated",
            },
          },
          "sts:AssumeRoleWithWebIdentity"
        ),
      }
    );

    // create required default role for authenticated users (validated by CDK)
    const cognito_authenticated_role = new iam.Role(this, "cognito-authenticated-role", {
      description: "Default role for authenticated users",
      assumedBy: new iam.FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": cognito_identity_pool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity"
      ),
    });

    // choose role for authenticated users from ID token (cognito:preferred_role)
    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      "identity-pool-role-attachment",
      {
        identityPoolId: cognito_identity_pool.ref,
        roles: {
          authenticated: cognito_authenticated_role.roleArn,
          unauthenticated: cognito_unauthenticated_role.roleArn,
        },
        roleMappings: {
          mapping: {
            type: "Token",
            ambiguousRoleResolution: "Deny",
            identityProvider: `cognito-idp.${cdk.Stack.of(this).region
              }.amazonaws.com/${cognito_user_pool.userPoolId}:${cognito_user_pool_client.userPoolClientId
              }`,
          },
        },
      }
    );

    // create s3 bucket to upload, manage and analyze documents to the repository
    const s3_source_bucket = new s3.Bucket(this, "s3-source-bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      cors: [
        {
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.POST,
            s3.HttpMethods.PUT,
          ],
          // updated as part of the build and deploy pipeline of the Amplify hosted front-end application
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
        },
      ],
    });

    // create source control repository for the react frontend app hosted on Amplify
    const code_commit_repository = new codecommit.Repository(this, "code-commit-repository", {
      repositoryName: "frontend-react-appliction",
      code: codecommit.Code.fromDirectory(
        path.join(__dirname, "/../../frontend-react/"),
        "main"
      ),
      description: "code repository for react frontend application",
    });
    code_commit_repository.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // Creation of SSM String parameter for Amplify authentication backend configuration
    const ampfliy_auth_ssm_param = new ssm.StringParameter(
      this,
      "ampfliy-auth-ssm-param",
      {
        allowedPattern: ".*",
        description: "Amplify auth backend configuration",
        parameterName: "ampfliyBackendAuthParam",
        stringValue: `{"BlogContentRepositoryStack":{"bucketName": "${s3_source_bucket.bucketName
          }","userPoolClientId": "${cognito_user_pool_client.userPoolClientId
          }","region": "${cdk.Stack.of(this).region}","userPoolId": "${cognito_user_pool.userPoolId
          }","identityPoolId": "${cognito_identity_pool.ref}"}}`,
        tier: ssm.ParameterTier.STANDARD,
      }
    );

    // create custom execution role for Amplify front-end application
    const amplify_exec_role = new iam.Role(this, "amplify-exec-role", {
      assumedBy: new iam.ServicePrincipal("amplify.amazonaws.com"),
      description: "Custom execution role to host and build Amplify front-end application",
    });

    // permission policy for Amplify execution role to host and build the frontend app
    const amplify_exec_policy = new iam.ManagedPolicy(this, 'amplify-exec-policy', {
      description: 'Read SSM parameter store to build the backend and update S3 CORS policy',
      statements: [
        new iam.PolicyStatement({
          resources: ['*'],
          actions: [
            "ssm:GetParameter",
          ],
        }),
        new iam.PolicyStatement({
          resources: ['*'],
          actions: ["s3:PutBucketCORS"],
        }),
      ],
      roles: [amplify_exec_role],
    });

    // Create Amplify front end application (react)
    const amplify_frontend_app = new amplify_alpha.App(this, "amplify-frontend-app", {
      sourceCodeProvider: new amplify_alpha.CodeCommitSourceCodeProvider({
        repository: code_commit_repository,
      }),
      role: amplify_exec_role,
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        // Prebuild step gets required Cognito user pool information to configure the Amplify Auth backend and writes it into a file which the react app loads dynamically at start
        // Postbuild step updates the CORS rule of the S3 bucket to allow communication with the Amplify hosted app only
        version: "1.0",
        frontend: {
          phases: {
            preBuild: {
              commands: [
                "npm install",
                "aws ssm get-parameter --name 'ampfliyBackendAuthParam' --query 'Parameter.Value' --output text > ./src/amplify_auth_config.json",
                "aws ssm get-parameter --name 'apiGatewayEndpointParam' --query 'Parameter.Value' --output text > ./src/components/api_endpoint.json",
              ],
            },
            build: {
              commands: ["npm run build"],
            },
            postBuild: {
              commands: [
                "CORS_RULE=$( aws ssm get-parameter --name 's3CorsRuleParam' --query 'Parameter.Value' --output text )",
                "BUCKET_NAME=$( aws ssm get-parameter --name 's3BucketNameParam' --query 'Parameter.Value' --output text )",
                'aws s3api put-bucket-cors --bucket "$BUCKET_NAME" --cors-configuration "$CORS_RULE"',
              ],
            },
          },
          artifacts: {
            baseDirectory: "build",
            files: ["**/*"],
          },
          cache: {
            commands: ["node_modules/**/*"],
          },
        },
      }),
    });
    amplify_frontend_app.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // connect Amplify app with the main branch of the code repolistory with the frontend code
    const main_branch = amplify_frontend_app.addBranch("main-branch", {
      autoBuild: true,
      branchName: "main",
    });
    // Amplify hosted app URL used for CORS origin configuration
    const allow_origin_url =
      "https://" + main_branch.branchName + "." + amplify_frontend_app.defaultDomain;

    // create Lambda function to list content of the s3 bucket
    const list_file_lambda = new lambda.Function(this, "list-file-lambda", {
      environment: {
        sourceBucketName: s3_source_bucket.bucketName,
        allowOrigins: allow_origin_url,
        region: cdk.Stack.of(this).region,
        idPoolId: cognito_identity_pool.ref,
        userPoolId: cognito_user_pool.userPoolId,
      },
      code: lambda.Code.fromAsset("lambdas"),
      handler: "list_file.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      runtime: lambda.Runtime.PYTHON_3_10,
    });

    // create Lambda function to create a presigned S3 url to upload a document from the frontend app to the content repository
    const presigned_url_lambda = new lambda.Function(this, "presigned-url-lambda", {
      environment: {
        sourceBucketName: s3_source_bucket.bucketName,
        allowOrigins: allow_origin_url,
        region: cdk.Stack.of(this).region,
        idPoolId: cognito_identity_pool.ref,
        userPoolId: cognito_user_pool.userPoolId,
        s3DepartmentTagKey: department_attribute_name,
      },
      code: lambda.Code.fromAsset("lambdas"),
      handler: "presigned_url.lambda_handler",
      timeout: cdk.Duration.seconds(30),
      runtime: lambda.Runtime.PYTHON_3_10,
    });

    // permission policy for the pre-token generation trigger to list the assigned groups from CUP users
    pre_token_lambda.role?.attachInlinePolicy(
      new iam.Policy(this, "pre-token-lambda-policy", {
        statements: [new iam.PolicyStatement({
          actions: ["cognito-idp:ListGroups"],
          resources: [cognito_user_pool.userPoolArn],
        })],
      })
    );

    // create REST API Gateway with a Cognito User Pool Authorizer
    const rest_api_gateway = new apigateway.RestApi(this, "rest-apigateway", {
      defaultCorsPreflightOptions: {
        allowOrigins: [allow_origin_url],
        allowMethods: ["OPTIONS,GET,POST"],
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
        allowCredentials: true,
      },
      deployOptions: {
        accessLogDestination: new apigateway.LogGroupLogDestination(new logs.LogGroup(this, "apigw-prd-logs")),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields()
      },
      endpointConfiguration: {
        types: [apigateway.EndpointType.EDGE]
      },
    });
    rest_api_gateway.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const list_documents = rest_api_gateway.root.addResource("list-documents");
    const create_presigned_url = rest_api_gateway.root.addResource("create-presigned-url");
    const search_documents = rest_api_gateway.root.addResource("search-documents");

    const apigw_user_pool_authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "apigw-user-pool-authorizer",
      {
        cognitoUserPools: [cognito_user_pool],
      }
    );

    list_documents.addMethod(
      "GET",
      new apigateway.LambdaIntegration(list_file_lambda),
      {
        authorizer: apigw_user_pool_authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      }
    );

    const presigned_url_request_body_schema = new apigateway.Model(this, 'presigned-url-request-body-schema', {
      restApi: rest_api_gateway,
      contentType: 'application/json',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          fileName: { type: apigateway.JsonSchemaType.STRING },
          fileType: { type: apigateway.JsonSchemaType.STRING },
        },
        required: ['fileName', 'fileType'],
      },
    })

    const presigned_url_request_body_validator = new apigateway.RequestValidator(this, 'presigned-url-request-body-validator', {
      restApi: rest_api_gateway,
      requestValidatorName: 'presignedUrlRequestBodyValidator',
      validateRequestBody: true,
      validateRequestParameters: false,
    })

    create_presigned_url.addMethod(
      "POST",
      new apigateway.LambdaIntegration(presigned_url_lambda),
      {
        authorizer: apigw_user_pool_authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        requestValidator: presigned_url_request_body_validator,
        requestModels: {
          'application/json': presigned_url_request_body_schema,
        }
      }
    );
    
    // add API Gateway endpoint to SSM parameter store to use it from the react frontend app during the build process
    // update execution role of the Amplify app accordingly
    const apigw_endpoint_ssm_param = new ssm.StringParameter(this, "apigw-endpoint-ssm-param", {
      allowedPattern: ".*",
      description: "Endpoint for API Gateway",
      parameterName: "apiGatewayEndpointParam",
      stringValue: `{"apiEndpoint": "${rest_api_gateway.url}","presignedResource": "${create_presigned_url.path}","listDocsResource": "${list_documents.path}","searchDocsResource": "${search_documents.path}"}`,
      tier: ssm.ParameterTier.STANDARD,
    });

    // add S3 cors rule and s3 bucket name to SSM parameter store to use it from the react frontend app during the build process
    // update execution role of the Amplify app accordingly
    const s3_cors_rule_param = new ssm.StringParameter(this, "s3-cors-rule-param", {
      allowedPattern: ".*",
      description: "S3 bucket CORS rule",
      parameterName: "s3CorsRuleParam",
      stringValue: `{"CORSRules" : [{"AllowedHeaders":["*"],"AllowedMethods":["GET","POST", "PUT"],"AllowedOrigins":["${allow_origin_url}"]}]}`,
      tier: ssm.ParameterTier.STANDARD,
    });
    const s3_source_bucket_name_param = new ssm.StringParameter(this, "s3-source-bucket-name-param", {
      allowedPattern: ".*",
      description: "S3 bucket name",
      parameterName: "s3BucketNameParam",
      stringValue: s3_source_bucket.bucketName,
      tier: ssm.ParameterTier.STANDARD,
    });

    //// SEARCH CAPABILITIES ////

    // create s3 bucket for ocr output and embeddings
    const s3_transformed_bucket = new s3.Bucket(this, "s3-transformed-bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // role for lambda function to ingest embeddings from s3 transformed bucket into opensearch index
    const os_index_ingest_role = new iam.Role(this, 'os-index-admin-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'ingest embeddings from s3 into opensearch index',
    });
    os_index_ingest_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"))
    os_index_ingest_role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY)

    // role for lambda function to search (knn) in opensearch index
    const os_index_search_role = new iam.Role(this, 'os-search-admin-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'knn search in opensearch index',
    });
    os_index_search_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"))
    os_index_search_role.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY)

    // create search domain 
    // this is a demo cluster only. In production, you should deploy the domain in a VPC and restrict the domain access policy by IP/CIDR additionally.
    // also, consider multiple data nodes, dedicated master nodes, and zone awareness
    const os_index = "content-repo-search"
    const os_domain = new opensearch.Domain(this, 'os-domain', { 
      version: opensearch.EngineVersion.openSearch('2.5'), // demo cluster only
      enableVersionUpgrade: true,
      capacity: {
        dataNodes: 1,
        dataNodeInstanceType: 't3.medium.search',
      },
      ebs: {
        volumeSize: 10
      },
      logging: {
        appLogEnabled: true,
        slowSearchLogEnabled: true,
        slowIndexLogEnabled: true,
      },
      nodeToNodeEncryption: true,
      encryptionAtRest: {
        enabled: true
      },
      enforceHttps: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // we don't expose OpenSearch to users directly, only the system itself ingests and retrives documents. 
    // in production, you should deploy the domain in a VPC though and restrict the domain access policy by IP/CIDR additionally.
    // for users accessing the OpenSearch domain i.e. dashboards, implement FGAC using Amazon Congito for authentication
    // https://docs.aws.amazon.com/opensearch-service/latest/developerguide/bp.html#bp-security
    // https://docs.aws.amazon.com/opensearch-service/latest/developerguide/fgac.html#fgac-recommendations
    os_domain.addAccessPolicies(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["es:ESHttp*"],
        principals: [
          new iam.ArnPrincipal(os_index_ingest_role.roleArn),
          new iam.ArnPrincipal(os_index_search_role.roleArn),
        ],
        resources: [os_domain.domainArn + "/*"],
      }),
    )
    os_domain.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY)


    // lambda function to ingest embeddings into opensearch
    const os_index_lambda = new lambda.Function(this, 'os-index-lambda', {
      code: lambda.Code.fromAsset((path.join(__dirname, "../lambdas/search/")),
        {
          bundling: {
            image: lambda.Runtime.PYTHON_3_10.bundlingImage,
            command: [
              'bash', '-c',
              'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
            ],
          },
        }),
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'os_index.lambda_handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        transformedBucketName: s3_transformed_bucket.bucketName,
        domainName: os_domain.domainEndpoint,
        region: cdk.Stack.of(this).region,
        index: os_index,
      },
      role: os_index_ingest_role,
    });

    new iam.ManagedPolicy(this, 'read-s3-transformed-bucket_policy', {
      description: 'Read objects and tags from transformed s3 bucket',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:GetObject",
            "s3:GetObjectTagging"],
          resources: [s3_transformed_bucket.bucketArn + '/*'],
        }),
      ],
      roles: [os_index_ingest_role],
    });

    // lambda function for (knn) search in opensearch
    const os_search_lambda = new lambda.Function(this, 'os-search-lambda', {
      code: lambda.Code.fromAsset((path.join(__dirname, "../lambdas/search/")),
        {
          bundling: {
            image: lambda.Runtime.PYTHON_3_10.bundlingImage,
            command: [
              'bash', '-c',
              'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'
            ],
          },
        }),
      runtime: lambda.Runtime.PYTHON_3_10,
      handler: 'os_search.lambda_handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        domainName: os_domain.domainEndpoint,
        region: cdk.Stack.of(this).region,
        allowOrigins: allow_origin_url,
        index: os_index,
        sagemakerEndpointParam: 'sagemaker-endpoint'
      },
      role: os_index_search_role,
    });
    new iam.ManagedPolicy(this, 'os-index-search-policy', {
      description: 'Opensearch index search policy',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/sagemaker-endpoint`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sagemaker:InvokeEndpoint"
          ],
          resources: [`arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint/*`],
        }),
      ],
      roles: [os_index_search_role],
    });

    const search_request_body_schema = new apigateway.Model(this, 'search-request-body-schema', {
      restApi: rest_api_gateway,
      contentType: 'application/json',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          query: { type: apigateway.JsonSchemaType.STRING },
        },
        required: ['query'],
      },
    })

    const search_request_body_validator = new apigateway.RequestValidator(this, 'search-request-body-validator', {
      restApi: rest_api_gateway,
      requestValidatorName: 'searchRequestBodyValidator',
      validateRequestBody: true,
      validateRequestParameters: false,
    })

    // create API endpoint for search
    search_documents.addMethod(
      "POST",
      new apigateway.LambdaIntegration(os_search_lambda),
      {
        authorizer: apigw_user_pool_authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        requestValidator: search_request_body_validator,
        requestModels: {
          'application/json': search_request_body_schema,
        },
      }
    );

    //invoke opensearch ingest lambda when an object is created in the s3_transformed_bucket
    s3_transformed_bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(os_index_lambda),
      { suffix: '.txt' },
    );

    // Source document in S3 -> SQS queue -> Document transformation Lambda function with textract sync API and Sagemaker emmbeddings-> transformed S3 bucket

    // create an SQS queue
    const sqs_queue = new sqs.Queue(this, 'source-bucket-event-queue', {
      visibilityTimeout: Duration.seconds(30),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // create S3 -> SQS notification with suffix filters       
    s3_source_bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(sqs_queue), { prefix: 'sales', suffix: '.txt' });

    s3_source_bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(sqs_queue), { prefix: 'sales', suffix: '.pdf' });

    s3_source_bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(sqs_queue), { prefix: 'sales', suffix: '.png' });

    s3_source_bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(sqs_queue), { prefix: 'marketing', suffix: '.txt' });

    s3_source_bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(sqs_queue), { prefix: 'marketing', suffix: '.pdf' });

    s3_source_bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(sqs_queue), { prefix: 'marketing', suffix: '.png' });


    // role for lambda function to run textract API
    const sync_textract_ops_role = new iam.Role(this, 'detect-text-ops-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Lambda function Role to make textract detect text call',
    });

    new iam.ManagedPolicy(this, 'detect-text-ops-role-policy', {
      description: 'Policy to allow textract detect text',
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "textract:DetectDocumentText",
            "textract:AnalyzeDocument"
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sagemaker:InvokeEndpoint"
          ],
          resources: [`arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint/*`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["ssm:GetParameter"],
          resources: [`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/sagemaker-endpoint`],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:GetObject",
            "s3:ListBucket",
            "s3:GetObjectTagging"
          ],
          resources: [s3_source_bucket.bucketArn, s3_source_bucket.bucketArn + '/*'],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "s3:PutObject",
            "s3:ListBucket",
            "s3:PutObjectTagging"
          ],
          resources: [s3_transformed_bucket.bucketArn, s3_transformed_bucket.bucketArn + '/*'],
        })
      ],
      roles: [sync_textract_ops_role],
    });

    // lambda function to extract the text from documents and create embeddings
    const textract_detect_text = new lambda.Function(this, 'textract-embeddings-lambda', {
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambdas/doc_transform/")),
      runtime: lambda.Runtime.PYTHON_3_10,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      handler: 'doc_textract_embedding.lambda_handler',
      reservedConcurrentExecutions: 1, // Set to 1 to limit to max one invocation per second - adjust this as per the detect-text API TPS quota in your chosen AWS region
      environment: {
        OCR_KEY: "reviewBody",
        DOC_KEY: "reviewid",
        EMBEDDINGS_OUTPUT_BUCKET: s3_transformed_bucket.bucketName,
        SM_SSM_PARAMETER: 'sagemaker-endpoint'
      },
      role: sync_textract_ops_role
    });

    
    textract_detect_text.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicExecutionRole',
      ),
    );

    // create IAM role for SageMaker notebook instance 
    const sagemaker_instance_role = new iam.Role(this,
      "sagemaker-instance-role",
      {
        description: "SageMaker instance role",
        assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com")
      }
    )

    // permission policy for SageMaker notebook instance execution role to access S3 and SSM parameter
    const sagemaker_instance_policy = new iam.ManagedPolicy(this, 'sagemaker-instance-policy', {
      description: 'Read SSM parameter store and access S3 bucket',
      statements: [
        new iam.PolicyStatement({
          resources: [`arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter/sagemaker-endpoint`],
          actions: [
            "ssm:GetParameter", "ssm:PutParameter"
          ],
        }),
        new iam.PolicyStatement({
          resources: [`arn:aws:s3:::sagemaker-${cdk.Stack.of(this).region}-${cdk.Stack.of(this).account}`, `arn:aws:s3:::sagemaker-${cdk.Stack.of(this).region}-${cdk.Stack.of(this).account}/*`],
          actions: ["s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:ListBucket", "s3:CreateBucket"],
        }),
        new iam.PolicyStatement({
          resources: ['*'],
          actions: ["sagemaker:*"],
        }),
        new iam.PolicyStatement({
          resources: ['arn:aws:iam::*:role/*'],
          actions: ["iam:PassRole"],
        }),
        new iam.PolicyStatement({
          resources: ["*"],
          actions: ["ecr:GetAuthorizationToken",
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage"],
        }),

      ],
      roles: [sagemaker_instance_role]
    });


    // add an event source to the Document transformation Lambda function that listens to SQS
    textract_detect_text.addEventSource(new eventsources.SqsEventSource(sqs_queue, { batchSize: 1 }));


    // relevant stack outputs
    new cdk.CfnOutput(this, "amplifyHostedAppUrl", {
      value: allow_origin_url,
    });
    new cdk.CfnOutput(this, "awsRegion", {
      value: cdk.Stack.of(this).region,
    });
    new cdk.CfnOutput(this, "s3SourceBucketName", {
      value: s3_source_bucket.bucketName,
    });
    new cdk.CfnOutput(this, "s3TransformedBucketName", {
      value: s3_transformed_bucket.bucketName,
    });
    new cdk.CfnOutput(this, "searchDomainName", {
      value: os_domain.domainName,
    });

    // exports to create demo data via separate cdk stack
    new cdk.CfnOutput(this, "cognitoUserPoolId", {
      value: cognito_user_pool.userPoolId,
      exportName: 'cognito-user-pool-id',
    });
    new cdk.CfnOutput(this, "cognitoUserPoolArn", {
      value: cognito_user_pool.userPoolArn,
      exportName: 'cognito-user-pool-arn',
    });
    new cdk.CfnOutput(this, "cognitoIdentityPoolRef", {
      value: cognito_identity_pool.ref,
      exportName: 'cognito-identity-pool-ref',
    });
    new cdk.CfnOutput(this, "s3SourceBucketArn", {
      value: s3_source_bucket.bucketArn,
      exportName: 's3-source-bucket-arn',
    });
    new cdk.CfnOutput(this, "amplifyFrontendAppId", {
      value: amplify_frontend_app.appId,
      exportName: 'amplify-frontend-app-id',
    });
    new cdk.CfnOutput(this, "codeRepoBranchName", {
      value: main_branch.branchName,
      exportName: 'code-repo-branch-name',
    });
    new cdk.CfnOutput(this, "codeRepoArn", {
      value: main_branch.arn,
      exportName: 'code-repo-arn',
    });

  }
}
