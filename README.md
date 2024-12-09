# dify on my aws by cdk

cdkで書いてみた. 多分とりあえず動くものにはなった

difyのバージョンは0.13.2

かなり雑なのでそのうちなおしたい
- secretが雑
- fargateのリソースが雑　オートスケーリングしたい
- elasticacheがサーバレスじゃない（サーバレスだとdifyがバグる）

構成図はこんな感じ

![](./memo/kousei.svg)

---

## Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
