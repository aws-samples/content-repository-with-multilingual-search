# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import json
import boto3
import os
import re
from collections import defaultdict
from urllib.parse import unquote_plus

# AWS service boto3 clients
textract = boto3.client('textract')
s3 = boto3.client('s3')
sagemaker_client = boto3.client('sagemaker-runtime')
ssm_client = boto3.client('ssm')

# extracting the environment variables
ocr_key = os.environ['OCR_KEY']
doc_key = os.environ['DOC_KEY']
destination_bucket_name = os.environ['EMBEDDINGS_OUTPUT_BUCKET']
ssm_parameter_name = os.environ['SM_SSM_PARAMETER']

# get the sagemaker endpoint for embeddings
ssm_response = ssm_client.get_parameter(
    Name=ssm_parameter_name
)
sagemaker_endpoint = ssm_response['Parameter']['Value']

# get the sagemaker endpoint for generating embeddings
fields_list = [ocr_key, doc_key]


def lambda_handler(event, context):
    # process each record in the event from the SQS queue
    for record in event['Records']:
        # get the S3 bucket and key from the event record
        json_body = (record["body"])
        json_record = json.loads(json_body)

        try:
            source_bucket_name = json_record["Records"][0]["s3"]["bucket"]["name"]
            object_key = json_record["Records"][0]["s3"]["object"]["key"]
        except KeyError:
            function_response = "lambda not triggered by s3 source bucket"
            continue

        # use Textract Sync API to extract text from the object
        response_textract = textract.analyze_document(
            Document={
                'S3Object': {
                    'Bucket': source_bucket_name,
                    'Name': object_key
                }
            },
            FeatureTypes=[
                'FORMS'
            ]
        )

        # call generate_parsed_text function with textract response to get the key-value pairs
        key_map, value_map, block_map = generate_parsed_text(response_textract)

        # get Key Value relationship
        kvs = get_kv_relationship(key_map, value_map, block_map)

        # start searching a key value that needs to be used for embedding generation
        search_key = ocr_key
        input_txt = search_value(kvs, search_key)

        try:
            payload_txt = str(input_txt[0])
            # prepare the payload for Sagemaker inference
            payload = {"key": payload_txt}

            # invoke SageMaker endpoint to generate embeddings for the source key
            response_sagemaker = sagemaker_client.invoke_endpoint(
                EndpointName=sagemaker_endpoint,
                Body=json.dumps(payload).encode(),
                ContentType='application/json')

            embeddings = response_sagemaker['Body'].read().decode('utf-8')
            embeddings_json = json.loads(embeddings)

            # write the textract key value pairs alongwith the embeddings to a text file
            function_response = write_to_s3(
                source_bucket_name, object_key, kvs, search_key, embeddings_json["predictions"][0])

        except IndexError:
            # Handle the IndexError by displaying a custom error message
            print("The list is empty.")
            function_response = "textract output not written to target bucket"

    response = {
        "statusCode": 200,
        "body": json.dumps(function_response)
    }

    return response


# function to write to S3
def write_to_s3(source_bucket_name, source_key, kvs, search_key, embeddings):
    txt_file_name = f'{source_key}.txt'
    obj_tags = s3.get_object_tagging(Bucket=source_bucket_name, Key=source_key)
    extracted_txt = {f"{search_key}_embeddings": embeddings}
    for field in fields_list:
        key_value = search_value(kvs, field)
        if key_value:  # None if no result
            extracted_txt[field] = (key_value[0]).strip()
        else:
            extracted_txt[field] = ""
            # if OCR didn't succeed, get the id via the object key
            if field == "reviewid":
                source_key = source_key.split("/")[-1]
                source_key = source_key.split(".")[0]
                extracted_txt[field] = source_key
    s3.put_object(Body=json.dumps(extracted_txt),
                  Bucket=destination_bucket_name, Key=txt_file_name)
    put_obj_tags = s3.put_object_tagging(
        Bucket=destination_bucket_name, Key=txt_file_name,
        Tagging={
            'TagSet': obj_tags['TagSet']
        })
    return ("textract output written to target bucket")

# https://github.com/aws-samples/amazon-textract-code-samples/blob/master/python/08-forms.py
# https://docs.aws.amazon.com/textract/latest/dg/examples-extract-kvp.html


def generate_parsed_text(response_textract):
    # Extract the detected form fields and values from the response
    # Get the text blocks
    blocks = response_textract['Blocks']

    # get key and value maps
    key_map = {}
    value_map = {}
    block_map = {}
    for block in blocks:
        block_id = block['Id']
        block_map[block_id] = block
        if block['BlockType'] == "KEY_VALUE_SET":
            if 'KEY' in block['EntityTypes']:
                key_map[block_id] = block
            else:
                value_map[block_id] = block

    return key_map, value_map, block_map


def get_kv_relationship(key_map, value_map, block_map):
    kvs = defaultdict(list)
    for block_id, key_block in key_map.items():
        value_block = find_value_block(key_block, value_map)
        key = get_text(key_block, block_map)
        key_new = key.rstrip()
        val = get_text(value_block, block_map)
        val_new = val.rstrip()
        kvs[key_new].append(val_new)
    return kvs


def find_value_block(key_block, value_map):
    for relationship in key_block['Relationships']:
        if relationship['Type'] == 'VALUE':
            for value_id in relationship['Ids']:
                value_block = value_map[value_id]
    return value_block


def search_value(kvs, search_key):
    for key, value in kvs.items():
        if re.search(search_key, key, re.IGNORECASE):
            return value


def get_text(result, blocks_map):
    text = ''
    if 'Relationships' in result:
        for relationship in result['Relationships']:
            if relationship['Type'] == 'CHILD':
                for child_id in relationship['Ids']:
                    word = blocks_map[child_id]
                    if word['BlockType'] == 'WORD':
                        text += word['Text'] + ' '
                    if word['BlockType'] == 'SELECTION_ELEMENT':
                        if word['SelectionStatus'] == 'SELECTED':
                            text += 'X '

    return text
