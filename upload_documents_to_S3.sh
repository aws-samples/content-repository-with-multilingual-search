#!/bin/bash
# Set the S3 bucket name and the local directory to upload
S3_BUCKET_NAME="content-repo-search-stack-XXXXXX" #TO_BE_UPDATED
LOCAL_SALES_DIR="assets/sample-documents-for-ingestion-sales"
LOCAL_MARKETING_DIR="assets/sample-documents-for-ingestion-marketing"
# upload sales documents to S3 staging path
aws s3 sync ${LOCAL_SALES_DIR} s3://${S3_BUCKET_NAME}/staging
aws s3api list-objects --bucket ${S3_BUCKET_NAME} --prefix staging/ --query 'Contents[].[Key]' --output text | xargs -n 1 aws s3api put-object-tagging --bucket ${S3_BUCKET_NAME} --tagging 'TagSet=[{Key=department,Value=sales}]' --key
aws s3 mv s3://${S3_BUCKET_NAME}/staging/ s3://${S3_BUCKET_NAME}/sales/ --recursive
# upload marketing documents to S3 staging path
aws s3 sync ${LOCAL_MARKETING_DIR} s3://${S3_BUCKET_NAME}/staging
aws s3api list-objects --bucket ${S3_BUCKET_NAME} --prefix staging/ --query 'Contents[].[Key]' --output text | xargs -n 1 aws s3api put-object-tagging --bucket ${S3_BUCKET_NAME} --tagging 'TagSet=[{Key=department,Value=marketing}]' --key
aws s3 mv s3://${S3_BUCKET_NAME}/staging/ s3://${S3_BUCKET_NAME}/marketing/ --recursive
