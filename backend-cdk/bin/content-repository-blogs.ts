#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BlogContentRepositorySearchStack } from '../lib/blog-content-repo-search-stack';
import { DemoDataStack } from '../lib/userpool-demo-data-stack';


const app = new cdk.App();

new BlogContentRepositorySearchStack(app, 'BlogContentRepositorySearchStack', {
  stackName: 'content-repo-search-stack',
  description: 'Creates all resources needed for the content repository with semantic search capability',
});

new DemoDataStack(app, 'DemoDataStack', {
  stackName: 'demo-data-stack',
  description: 'Creates exemplary Cognito user pool users and groups and maps it to IAM roles with permission policies',
});