# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import boto3
from botocore.config import Config
from opensearchpy import OpenSearch, RequestsHttpConnection
from requests_aws4auth import AWS4Auth
import os
import urllib

region = os.environ['region']
bucketName = os.environ['transformedBucketName']
credentials = boto3.Session().get_credentials()
awsauth = AWS4Auth(credentials.access_key, credentials.secret_key,
                   region, 'es', session_token=credentials.token)

host = os.environ['domainName']
index = os.environ['index']

# create the s3 client
s3_client = boto3.client(
    's3',
    aws_access_key_id=credentials.access_key,
    aws_secret_access_key=credentials.secret_key,
    aws_session_token=credentials.token,
    region_name=region,
    config=Config(signature_version='s3v4'))

# create opensearch client
os_client = OpenSearch(
    hosts=[{'host': host, 'port': 443}],
    http_auth=awsauth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection
)

# OpenSearch index settings and knn_vector mapping
# Approximate k-NN search options and parameters: https://opensearch.org/docs/2.5/search-plugins/knn/knn-index/
# Lucene HNSW implementation
knn_index = {
    "settings": {
        "index.knn": True
    },
    "mappings": {
        "properties": {
            "reviewBody_embeddings": {
                "type": "knn_vector",
                "dimension": 512,
                "method": {
                    "name": "hnsw",
                    "space_type": "cosinesimil",
                    "engine": "lucene",
                    "parameters": {
                        "ef_construction": 512,
                        "m": 16
                    }
                }
            }
        }
    }
}

# Lambda execution starts here
def lambda_handler(event, context):
    response = []
    # Loop through each event record (can be multiple records passed-in)
    for record in event['Records']:

        # get details of the object that triggered the event
        source_bucket = record['s3']['bucket']['name']
        source_key = urllib.parse.unquote_plus(record['s3']['object']['key'])

        # read object
        s3_object = s3_client.get_object(Bucket=source_bucket, Key=source_key)
        # load as json
        s3_content = json.loads(s3_object['Body'].read().decode('utf-8'))

        # check if opensearch index already exists
        if not os_client.indices.exists(index=index):
            result = os_client.indices.create(index=index, body=knn_index)
            response.append(result)

        # get tag values of s3 object to ingest as additional fields
        s3_tags = s3_client.get_object_tagging(
            Bucket=source_bucket, Key=source_key)
        for tag in s3_tags['TagSet']:
            s3_content[tag['Key']] = tag['Value']

        # insert into opensearch index
        result = os_client.index(index=index, body=s3_content)
        response.append(result)

    response = {
        "statusCode": 200,
        "body": json.dumps(response)
    }

    return response
