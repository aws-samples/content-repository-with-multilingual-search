#!/usr/bin/env node

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BlogContentRepositorySearchStack } from '../lib/blog-content-repo-search-stack';
import { DemoDataStack } from '../lib/userpool-demo-data-stack';


const app = new cdk.App();

const repository_stack = new BlogContentRepositorySearchStack(app, 'BlogContentRepositorySearchStack', {
  stackName: 'content-repo-search-stack',
  description: 'Creates all resources needed for the content repository with semantic search capability',
});

const demo_data_stack = new DemoDataStack(app, 'DemoDataStack', {
  stackName: 'demo-data-stack',
  description: 'Creates exemplary Cognito user pool users and groups and maps it to IAM roles with permission policies',
});

// DemoDataStack depends on resources from the BlogContentRepositorySearchStack
demo_data_stack.addDependency(repository_stack)