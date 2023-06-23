# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import boto3
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth
import os

region = os.environ['region']
allow_origins = os.environ['allowOrigins']
credentials = boto3.Session().get_credentials()
awsauth = AWS4Auth(credentials.access_key, credentials.secret_key,
                   region, 'es', session_token=credentials.token)

host = os.environ['domainName']
index = os.environ['index']
ssm_parameter_name = os.environ['sagemakerEndpointParam']

# create opensearch client
os_client = OpenSearch(
    hosts=[{'host': host, 'port': 443}],
    http_auth=awsauth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection
)

# create sagemaker and ssm clients
sagemaker_client = boto3.client('sagemaker-runtime')
ssm_client = boto3.client('ssm')

# get the sagemaker endpoint for embeddings
ssm_response = ssm_client.get_parameter(
    Name=ssm_parameter_name
)
sagemaker_endpoint = ssm_response['Parameter']['Value']


def lambda_handler(event, context):

    # get the group i.e. department for the user's token claims to filter the search results
    user_department = event['requestContext']['authorizer']['claims']['department']

    # get search query from request body
    body = json.loads(event['body'])
    search_query = body['query']

    # prepare the payload for Sagemaker inference
    payload = {"key": str(search_query)}

    # invoke SageMaker endpoint to generate embeddings for the search string
    response_sagemaker = sagemaker_client.invoke_endpoint(
        EndpointName=sagemaker_endpoint,
        Body=json.dumps(payload).encode(),
        ContentType='application/json')

    embeddings = response_sagemaker['Body'].read().decode('utf-8')
    embeddings_json = json.loads(embeddings)

    # approximate k-NN search query
    # knn search filter options: https://opensearch.org/docs/2.5/search-plugins/knn/filter-search-knn/
    # Lucene k-NN filter
    knn_search = {
        "size": 3,
        "query": {
            "knn": {
                "reviewBody_embeddings": {
                    "vector": embeddings_json["predictions"][0],
                    "k": 3,
                    "filter": {
                        "term": {
                            "department": user_department
                        }
                    }
                }
            }
        }
    }

    # search
    result = {}
    result["index_size"] = 0

    if os_client.indices.exists(index=index):
        result = os_client.search(index=index, body=knn_search)
        result['index_size'] = os_client.count(index=index)['count']

    response = {
        "statusCode": 200,
        "headers": {
            'Access-Control-Allow-Origin': allow_origins,
            'Access-Control-Allow-Credentials': 'true',
        },
        "body": json.dumps(result)
    }
    print (response)
    return response
