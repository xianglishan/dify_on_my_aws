import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as custom from 'aws-cdk-lib/custom-resources';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
// import * as efs from 'aws-cdk-lib/aws-efs';
import * as secret from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';

import 'dotenv/config';

export class CdkStack extends cdk.Stack {

  private readonly DOMAIN = process.env.DOMAIN

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    ////////////////////////
    // Vpc
    ////////////////////////

    // VPCの作成
    const vpc = new ec2.Vpc(this, 'MyVPC', {
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
      natGatewayProvider: ec2.NatProvider.instanceV2({
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO)
      }),
      natGateways: 1,
    });

    // 特定のAZ（NATインスタンスがある方）のプライベートサブネットを選択（節約のため）
    const privateSubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      availabilityZones: [vpc.availabilityZones[0]], // 最初のAZのみ選択
    };

    // S3のゲートウェイ型VPCエンドポイント作成
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Security Groups作成
    const sgAlb = new ec2.SecurityGroup(this, 'SecurityGroupA', {
      vpc,
      description: 'Security group for ALB',
      allowAllOutbound: true,
    });
    
    const sgFargate = new ec2.SecurityGroup(this, 'SecurityGroupB', {
      vpc,
      description: 'Security group for Fargate',
      allowAllOutbound: true,
      disableInlineRules: true // 自己参照可
    });

    const sgNat = new ec2.SecurityGroup(this, 'SecurityGroupC', {
      vpc,
      description: 'Security group for NAT Instance',
      allowAllOutbound: true,
    });

    const sgVpcEndpoint = new ec2.SecurityGroup(this, 'SecurityGroupD', {
      vpc,
      description: 'Security group for VPC Endpoint',
      allowAllOutbound: true,
    });

    // Security Group Rules
    sgAlb.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS from anywhere'
    );

    sgFargate.addIngressRule(
      ec2.Peer.securityGroupId(sgFargate.securityGroupId),
      ec2.Port.allTcp(),
      'Allow TCP from self'
    );

    // // ALBからFargateへの通信を許可
    // sgFargate.addIngressRule(
    //   ec2.Peer.securityGroupId(sgAlb.securityGroupId),
    //   ec2.Port.allTcp(),
    //   'Allow HTTP from ALB to Web container'
    // );

    sgNat.addIngressRule(
      ec2.Peer.securityGroupId(sgFargate.securityGroupId),
      ec2.Port.allTcp(),
      'Allow TCP from Fargate'
    );

    sgVpcEndpoint.addIngressRule(
      ec2.Peer.securityGroupId(sgFargate.securityGroupId),
      ec2.Port.allTcp(),
      'Allow TCP from Fargate'
    );

    ////////////////////////
    // s3
    ////////////////////////

    // S3バケットの作成
    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      bucketName: `${this.account}-user-uploads-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // CDK destroyで削除可能に
      autoDeleteObjects: true, // バケット内のオブジェクトも自動削除
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: uploadBucket.bucketName,
      description: 'The name of the S3 bucket',
    });

    ////////////////////////
    // ACM証明書
    // サブドメインをroute53に登録するところまでは手動でやった
    ////////////////////////

    // Route 53のホストゾーンを参照
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: this.DOMAIN!
    });

    // ACM証明書の作成
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: this.DOMAIN!,
      validation: acm.CertificateValidation.fromDns(hostedZone),
      subjectAlternativeNames: [
        `*.${this.DOMAIN}`
      ],
    });

    // 暗号化用のsecret 中身はただの文字列 (いろいろな用途にこれ一個だけ使ってる。後で直さないとかも?)
    const encryptionSecret = new secret.Secret(this, 'EncriptionSecret', {
      generateSecretString: {
        passwordLength: 42,
        excludePunctuation: true
      }
    });

    ////////////////////////
    // postgres (Aurora serverless v2)
    // TODO:セキュリティグループ
    ////////////////////////

    // Aurora Serverless v2 の作成
    const dbCluster = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      vpc,
      vpcSubnets: {subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS},
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      readers: [
        // rds.ClusterInstance.serverlessV2('Reader1'), //テストのときは時間短縮＆コストカットのためリーダーノード無し
      ],
      securityGroups: [sgFargate],
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // データベースの初期設定
      defaultDatabaseName: 'appdb',
      enableDataApi: true, // Data APIでクエリできる
      // パラメータグループの設定
      parameterGroup: new rds.ParameterGroup(this, 'DatabaseParameterGroup', {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_4,
        }),
        parameters: {
          // Terminate idle session for Aurora Serverless V2 auto-pause
          idle_session_timeout: '60000',
        },
      }),
    });

    new cdk.CfnOutput(this, 'AuroraEndpoint', {
      value: dbCluster.clusterEndpoint.hostname,
      description: 'The endpoint of the Aurora cluster',
    });

    // 新しいデータベース「pgvecdb」を作成するカスタムリソース
    const createPgVecDb = new custom.AwsCustomResource(this, 'CreatePgVecDb', {
      onCreate: {
        service: 'rds-data',
        action: 'executeStatement',
        parameters: {
          resourceArn: dbCluster.clusterArn,
          secretArn: dbCluster.secret?.secretArn,
          database: 'appdb', // デフォルトデータベースから実行
          sql: 'CREATE DATABASE pgvecdb;',
        },
        physicalResourceId: custom.PhysicalResourceId.of('CreatePgVecDb'),
      },
      policy: custom.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [dbCluster.clusterArn, dbCluster.secret?.secretArn || ''],
      }),
    });

    // pgvector拡張を有効化するためのカスタムリソース
    const enablePgVector = new custom.AwsCustomResource(this, 'EnablePgVector', {
      onCreate: {
        service: 'rds-data',
        action: 'executeStatement',
        parameters: {
          resourceArn: dbCluster.clusterArn,
          secretArn: dbCluster.secret?.secretArn,
          database: 'pgvecdb', // 新しく作成したデータベースで実行
          sql: 'CREATE EXTENSION IF NOT EXISTS vector;',
        },
        physicalResourceId: custom.PhysicalResourceId.of('EnablePgVector'),
      },
      policy: custom.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [dbCluster.clusterArn, dbCluster.secret?.secretArn || ''],
      }),
    });

    // 必要な権限を付与
    dbCluster.secret!.grantRead(createPgVecDb);
    dbCluster.grantDataApiAccess(createPgVecDb);

    dbCluster.secret!.grantRead(enablePgVector);
    dbCluster.grantDataApiAccess(enablePgVector);

    // 依存関係を設定
    createPgVecDb.node.addDependency(dbCluster);
    enablePgVector.node.addDependency(createPgVecDb);

    new cdk.CfnOutput(this, 'PgVectorEndpoint', {
      value: dbCluster.clusterEndpoint.hostname,
      description: 'The endpoint of the PgVector instance',
    });

    ////////////////////////
    // redis
    // TODO:セキュリティグループ
    ////////////////////////

    // ユーザーを作成（パスワードを設定）
    const redisUser = new elasticache.CfnUser(this, 'RedisUser', {
      engine: 'valkey',
      userId: 'default-user',
      userName: 'default-user',
      accessString: 'on ~* +@all',  // すべての権限を付与
      authenticationMode: {
        Type: 'password',
        Passwords: [encryptionSecret.secretValue.unsafeUnwrap()], // パスワードは多分これだと本番環境にはまずい
      },
    });

    // ユーザーグループを作成
    const redisUserGroup = new elasticache.CfnUserGroup(this, 'RedisUserGroup', {
      engine: 'valkey',
      userGroupId: 'redis-user-group',
      userIds: [redisUser.userId], // デフォルトユーザーを指定
    });

    // ElastiCache for Redis (Valkey) の作成
    // ElastiCache Serverlessの作成
    // const redisCache = new elasticache.CfnServerlessCache(this, 'RedisCache', {
    //   engine: 'valkey',
    //   serverlessCacheName: 'serverless-cache',
    //   securityGroupIds: [sgFargate.securityGroupId],
    //   subnetIds: vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS}).subnetIds, // もしかしたら複数じゃないとダメかも
    //   userGroupId: redisUserGroup.userGroupId
    // });

    // サーバレスじゃないredis作成 サーバレスだとクラスターモードになる　クラスターモードだとdifyがバグる（未サポート？）
    // subnetグループ作らないといけないらしい…だるい
    const redissubnetgroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnet group for Redis',
      subnetIds: vpc.selectSubnets({subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS}).subnetIds,
      cacheSubnetGroupName: 'my-redis-subnet-group',
    });

    const redisCache = new elasticache.CfnReplicationGroup(this, 'RedisCache', {
      engine: 'valkey', 
      replicationGroupId: 'redis',
      replicationGroupDescription: 'Redis instance',
      engineVersion: '7.2',
      cacheNodeType: 'cache.t4g.micro', 
      port: 6379, 
      replicasPerNodeGroup: 0,
      numNodeGroups: 1,
      automaticFailoverEnabled: false, 
      multiAzEnabled: false, 
      cacheSubnetGroupName: redissubnetgroup.ref, 
      securityGroupIds: [sgFargate.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true, 
      userGroupIds: [redisUserGroup.userGroupId]
    });

    // 依存関係の設定
    redisUserGroup.node.addDependency(redisUser);
    redisCache.node.addDependency(redisUserGroup);

    // Redis エンドポイントの出力
    new cdk.CfnOutput(this, 'RedisEndpoint', {
      value: `${redisCache.attrPrimaryEndPointAddress}:${redisCache.attrPrimaryEndPointPort}`,
      description: 'The endpoint of the Redis cache',
    });

    ////////////////////////
    // Fargate
    // TODO:環境変数
    // TODO:メモリとCPU,autoscaling
    ////////////////////////
  
    // Service Discovery用のプライベートDNSネームスペースを作成
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'DifyNamespace', {
      name: 'dify.local',  // 内部での名前解決に使用するドメイン
      vpc,
      description: 'Private namespace for Dify services',
    });

    // // EFSファイルシステムの作成
    // const fileSystem = new efs.FileSystem(this, 'DifyFileSystem', {
    //   vpc,
    //   vpcSubnets: privateSubnetSelection,
    //   securityGroup: sgFargate,  
    //   removalPolicy: cdk.RemovalPolicy.DESTROY,
    //   lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
    //   performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
    //   throughputMode: efs.ThroughputMode.BURSTING,
    // });

    // // EFSアクセスポイントの作成
    // const accessPoint = fileSystem.addAccessPoint('DifyAccessPoint', {
    //   path: '/volumes/app/storage',
    //   createAcl: {
    //     ownerGid: '1000',
    //     ownerUid: '1000',
    //     permissions: '755'
    //   },
    //   posixUser: {
    //     gid: '1000',
    //     uid: '1000'
    //   },
    // });
    
    // ECSクラスターの作成
    const cluster = new ecs.Cluster(this, 'DifyCluster', {
      vpc,
      containerInsights: true,
    });

    // 共通のログ設定
    const getLogDriver = (serviceName: string) => {
      return ecs.LogDriver.awsLogs({
        streamPrefix: serviceName,
        logRetention: logs.RetentionDays.ONE_WEEK,
      });
    };

    // API Service
    const apiTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });
    
    // secretへのread権限を付与
    dbCluster.secret!.grantRead(apiTaskDefinition.taskRole);
    encryptionSecret.grantRead(apiTaskDefinition.taskRole);

    // // EFSボリュームを追加
    // apiTaskDefinition.addVolume({
    //   name: 'storage',
    //   efsVolumeConfiguration: {
    //     fileSystemId: fileSystem.fileSystemId,
    //     transitEncryption: 'ENABLED',
    //     authorizationConfig: {
    //       accessPointId: accessPoint.accessPointId,
    //     },
    //   },
    // });

    // APIコンテナを変数に格納
    const apiContainer = apiTaskDefinition.addContainer('api', {
      image: ecs.ContainerImage.fromRegistry('langgenius/dify-api:0.13.2'),
      logging: getLogDriver('api'),
      environment: {
        DIFY_PORT: '5001', 
        MODE: 'api',
        LOG_LEVEL: 'INFO', 
        DEBUG: 'false',

        MIGRATION_ENABLED: 'true', 

        // The base URL of console application web frontend, refers to the Console base URL of WEB service if console domain is
        // different from api or web app domain.
        CONSOLE_WEB_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        // The base URL of console application api server, refers to the Console base URL of WEB service if console domain is different from api or web app domain.
        CONSOLE_API_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        // The URL prefix for Service API endpoints, refers to the base URL of the current API service if api domain is different from console domain.
        SERVICE_API_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        // The URL prefix for Web APP frontend, refers to the Web App base URL of WEB service if web app domain is different from console or api domain.
        APP_WEB_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        
        // Enable pessimistic disconnect handling for recover from Aurora automatic pause
        // https://docs.sqlalchemy.org/en/20/core/pooling.html#disconnect-handling-pessimistic
        SQLALCHEMY_POOL_PRE_PING: "True",
        
        REDIS_HOST: redisCache.attrPrimaryEndPointAddress,
        REDIS_PORT: redisCache.attrPrimaryEndPointPort,
        REDIS_USERNAME: redisUser.userName,
        REDIS_USE_SSL: 'true',
        REDIS_DB: '0',

        CELERY_BROKER_URL: `rediss://${redisUser.userName}:${encodeURIComponent(encryptionSecret.secretValue.unsafeUnwrap())}@${redisCache.attrPrimaryEndPointAddress}:${redisCache.attrPrimaryEndPointPort}/1`,
        BROKER_USE_SSL:'true', 
        
        // Specifies the allowed origins for cross-origin requests to the Web API, e.g. https://dify.app or * for all origins.
        WEB_API_CORS_ALLOW_ORIGINS: '*',
        // Specifies the allowed origins for cross-origin requests to the console API, e.g. https://cloud.dify.ai or * for all origins.
        CONSOLE_CORS_ALLOW_ORIGINS: '*',
        
        // The type of storage to use for storing user files.
        STORAGE_TYPE: 's3',
        S3_BUCKET_NAME: uploadBucket.bucketName,
        S3_REGION: cdk.Stack.of(uploadBucket).region,
        
        // postgres settings. the credentials are in secrets property.
        DB_DATABASE: 'appdb',
        
        // pgvector configurations
        VECTOR_STORE: 'pgvector',
        PGVECTOR_DATABASE: 'pgvecdb', 
        
        // The sandbox service endpoint.
        CODE_EXECUTION_ENDPOINT: 'http://sandbox.dify.local:8194', 
        
      },
      secrets: {
        // The configurations of postgres database connection.
        // It is consistent with the configuration in the 'db' service below.
        DB_USERNAME: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'username'),
        DB_HOST: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'port'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'password'),
        PGVECTOR_USER: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'username'),
        PGVECTOR_HOST: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'host'),
        PGVECTOR_PORT: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'port'),
        PGVECTOR_PASSWORD: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'password'),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(encryptionSecret),
        SECRET_KEY: ecs.Secret.fromSecretsManager(encryptionSecret),
        CODE_EXECUTION_API_KEY: ecs.Secret.fromSecretsManager(encryptionSecret), // is it ok to reuse this?
      },
      portMappings: [{ containerPort: 5001 }],
      healthCheck: {
        command: ['CMD-SHELL', `curl -f http://localhost:5001/health || exit 1`],
        interval: cdk.Duration.seconds(30),
        startPeriod: cdk.Duration.seconds(90),
        timeout: cdk.Duration.seconds(5),
        retries: 5,
      },
    });

    uploadBucket.grantReadWrite(apiTaskDefinition.taskRole); 

    // // マウントポイントを追加
    // apiContainer.addMountPoints({
    //   sourceVolume: 'storage',
    //   containerPath: '/app/api/storage',
    //   readOnly: false,
    // });
    
    const apiService = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTaskDefinition,
      desiredCount: 1,
      securityGroups: [sgFargate],
      vpcSubnets: privateSubnetSelection,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        },
        {
          capacityProvider: 'FARGATE',
          weight: 0,
        }
      ],
      cloudMapOptions: {
        name: 'api',  // api.dify.local で解決可能に
        cloudMapNamespace: namespace,
        dnsTtl: cdk.Duration.seconds(60),
      },
      enableExecuteCommand: true,
    });
    
    // Worker Service
    const workerTaskDefinition = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });
    
    // secretへのread権限を付与
    dbCluster.secret!.grantRead(workerTaskDefinition.taskRole);
    encryptionSecret.grantRead(workerTaskDefinition.taskRole);

    // // EFSボリュームを追加
    // workerTaskDefinition.addVolume({
    //   name: 'storage',
    //   efsVolumeConfiguration: {
    //     fileSystemId: fileSystem.fileSystemId,
    //     transitEncryption: 'ENABLED',
    //     authorizationConfig: {
    //       accessPointId: accessPoint.accessPointId,
    //     },
    //   },
    // });

    // Workerコンテナを変数に格納
    const workerContainer = workerTaskDefinition.addContainer('worker', {
      image: ecs.ContainerImage.fromRegistry('langgenius/dify-api:0.13.2'),
      logging: getLogDriver('worker'),
      environment: {
        MODE: 'worker',
        LOG_LEVEL: 'INFO', 
        DEBUG: 'false',

        MIGRATION_ENABLED: 'true', 

        // The base URL of console application web frontend, refers to the Console base URL of WEB service if console domain is
        // different from api or web app domain.
        CONSOLE_WEB_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        // The base URL of console application api server, refers to the Console base URL of WEB service if console domain is different from api or web app domain.
        CONSOLE_API_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        // The URL prefix for Service API endpoints, refers to the base URL of the current API service if api domain is different from console domain.
        SERVICE_API_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        // The URL prefix for Web APP frontend, refers to the Web App base URL of WEB service if web app domain is different from console or api domain.
        APP_WEB_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,

        // Enable pessimistic disconnect handling for recover from Aurora automatic pause
        // https://docs.sqlalchemy.org/en/20/core/pooling.html#disconnect-handling-pessimistic
        SQLALCHEMY_POOL_PRE_PING: "True",

        REDIS_HOST: redisCache.attrPrimaryEndPointAddress,
        REDIS_PORT: redisCache.attrPrimaryEndPointPort,
        REDIS_USERNAME: redisUser.userName,
        REDIS_USE_SSL: 'true',
        REDIS_DB: '0',
        
        // REDIS_USE_CLUSTERS:'true', 
        // REDIS_CLUSTERS:`${redisCache.attrEndpointAddress}:${redisCache.attrEndpointPort}`, 
        
        CELERY_BROKER_URL: `rediss://${redisUser.userName}:${encodeURIComponent(encryptionSecret.secretValue.unsafeUnwrap())}@${redisCache.attrPrimaryEndPointAddress}:${redisCache.attrPrimaryEndPointPort}/1`,
        BROKER_USE_SSL:'true', 

        // Specifies the allowed origins for cross-origin requests to the Web API, e.g. https://dify.app or * for all origins.
        WEB_API_CORS_ALLOW_ORIGINS: '*',
        // Specifies the allowed origins for cross-origin requests to the console API, e.g. https://cloud.dify.ai or * for all origins.
        CONSOLE_CORS_ALLOW_ORIGINS: '*',

        // The type of storage to use for storing user files.
        STORAGE_TYPE: 's3',
        S3_BUCKET_NAME: uploadBucket.bucketName,
        S3_REGION: cdk.Stack.of(uploadBucket).region,

        // postgres settings. the credentials are in secrets property.
        DB_DATABASE: 'appdb',

        // pgvector configurations
        VECTOR_STORE: 'pgvector',
        PGVECTOR_DATABASE: 'pgvecdb', 

        // The sandbox service endpoint.
        CODE_EXECUTION_ENDPOINT: 'http://sandbox.dify.local:8194', 

      },
      secrets: {
        // The configurations of postgres database connection.
        // It is consistent with the configuration in the 'db' service below.
        DB_USERNAME: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'username'),
        DB_HOST: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'host'),
        DB_PORT: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'port'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'password'),
        PGVECTOR_USER: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'username'),
        PGVECTOR_HOST: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'host'),
        PGVECTOR_PORT: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'port'),
        PGVECTOR_PASSWORD: ecs.Secret.fromSecretsManager(dbCluster.secret!, 'password'),
        REDIS_PASSWORD: ecs.Secret.fromSecretsManager(encryptionSecret),
        SECRET_KEY: ecs.Secret.fromSecretsManager(encryptionSecret),
        CODE_EXECUTION_API_KEY: ecs.Secret.fromSecretsManager(encryptionSecret), // is it ok to reuse this?
      },
    });

    // // マウントポイントを追加
    // workerContainer.addMountPoints({
    //   sourceVolume: 'storage',
    //   containerPath: '/app/api/storage',
    //   readOnly: false,
    // });

    const workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      taskDefinition: workerTaskDefinition,
      desiredCount: 1,
      securityGroups: [sgFargate],
      vpcSubnets: privateSubnetSelection,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE',
          weight: 0,
        },
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        },
      ],
      cloudMapOptions: {
        name: 'worker',  // worker.dify.local で解決可能に
        cloudMapNamespace: namespace,
        dnsTtl: cdk.Duration.seconds(60),
      },
      enableExecuteCommand: true,
    });

    // Web Service
    const webTaskDefinition = new ecs.FargateTaskDefinition(this, 'WebTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });

    webTaskDefinition.addContainer('web', {
      image: ecs.ContainerImage.fromRegistry('langgenius/dify-web:0.13.2'),
      logging: getLogDriver('web'),
      environment: {
        LOG_LEVEL: 'INFO', 
        DEBUG: 'false',

        // The base URL of console application api server, refers to the Console base URL of WEB service if console domain is different from api or web app domain.
        CONSOLE_API_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
        // The URL prefix for Web APP frontend, refers to the Web App base URL of WEB service if web app domain is different from console or api domain.
        // example: http://udify.app
        APP_API_URL: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`, 

        // Setting host to 0.0.0.0 seems necessary for health check to pass.
        // https://nextjs.org/docs/pages/api-reference/next-config-js/output
        HOSTNAME: '0.0.0.0',
        PORT: '3000',
      },
      portMappings: [{ containerPort: 3000 }],
      healthCheck: {
        // use wget instead of curl due to alpine: https://stackoverflow.com/a/47722899/18550269
        command: ['CMD-SHELL', `wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1`],
        interval: cdk.Duration.seconds(30),
        startPeriod: cdk.Duration.seconds(90),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    const webService = new ecs.FargateService(this, 'WebService', {
      cluster,
      taskDefinition: webTaskDefinition,
      desiredCount: 1,
      securityGroups: [sgFargate],
      vpcSubnets: privateSubnetSelection,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE',
          weight: 0,
        },
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        },
      ],
      // Service Discovery設定を追加
      cloudMapOptions: {
        name: 'web',  // web.dify.local で解決可能に
        cloudMapNamespace: namespace,
        dnsTtl: cdk.Duration.seconds(60),
      },
      enableExecuteCommand: true,
    });

    // Sandbox Service
    const sandboxTaskDefinition = new ecs.FargateTaskDefinition(this, 'SandboxTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });

    // secretへのread権限を付与
    encryptionSecret.grantRead(sandboxTaskDefinition.taskRole);

    sandboxTaskDefinition.addContainer('sandbox', {
      image: ecs.ContainerImage.fromRegistry('langgenius/dify-sandbox:0.2.10'),
      logging: getLogDriver('sandbox'),
      environment: {
        GIN_MODE: 'release',
        WORKER_TIMEOUT: '15',
        ENABLE_NETWORK: 'true',
        ALLOWED_SYSCALLS: Array(457)
                .fill(0)
                .map((_, i) => i)
                .join(','),
        PYTHON_LIB_PATH: [
          // Originally from here:
          // https://github.com/langgenius/dify-sandbox/blob/main/internal/static/config_default_amd64.go
          '/usr/local/lib/python3.10',
          '/usr/lib/python3.10',
          '/usr/lib/python3',
          // copy all the lib. **DO NOT** add a trailing slash!
          '/usr/lib/x86_64-linux-gnu',
          '/etc/ssl/certs/ca-certificates.crt',
          '/etc/nsswitch.conf',
          '/etc/hosts',
          '/etc/resolv.conf',
          '/run/systemd/resolve/stub-resolv.conf',
          '/run/resolvconf/resolv.conf',
        ].join(','),

        // 'HTTP_PROXY':　'http://ssrf_proxy:3128', //ssrf_proxyはnat instanceで代用
        // 'HTTPS_PROXY': 'http://ssrf_proxy:3128', //
        SANDBOX_PORT: '8194',
      },
      secrets: {
        API_KEY: ecs.Secret.fromSecretsManager(encryptionSecret),
      },
      portMappings: [{ containerPort: 8194 }],
      healthCheck: {
        command: ["CMD-SHELL", "curl -f http://localhost:8194/health || exit 1"],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
      },
    });

    const sandboxService = new ecs.FargateService(this, 'SandboxService', {
      cluster,
      taskDefinition: sandboxTaskDefinition,
      desiredCount: 1,
      securityGroups: [sgFargate],
      vpcSubnets: privateSubnetSelection,
      capacityProviderStrategies: [
        {
          capacityProvider: 'FARGATE_SPOT',
          weight: 1,
        },
        {
          capacityProvider: 'FARGATE',
          weight: 0,
        }
      ], 
      // Service Discovery設定を追加
      cloudMapOptions: {
        name: 'sandbox',  // sandbox.dify.local で解決可能に
        cloudMapNamespace: namespace,
        dnsTtl: cdk.Duration.seconds(60),
      },
      enableExecuteCommand: true,
    });

    // すべてのECSサービスをdbClusterとPgVector設定の後に起動するように依存関係を設定
    apiService.node.addDependency(enablePgVector);
    workerService.node.addDependency(enablePgVector);
    webService.node.addDependency(enablePgVector);
    sandboxService.node.addDependency(enablePgVector);

    ////////////////////////
    // ALB target
    ////////////////////////

    // ALB作成
    const alb = new elbv2.ApplicationLoadBalancer(this, 'MyALB', {
      vpc,
      internetFacing: true,
      securityGroup: sgAlb,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });

    // ターゲットグループの作成
    const webTargetGroup = new elbv2.ApplicationTargetGroup(this, 'WebTargetGroup', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: {
        path: '/apps',
        healthyHttpCodes: '200',
      },
    });

    const apiTargetGroup = new elbv2.ApplicationTargetGroup(this, 'ApiTargetGroup', {
      vpc,
      port: 5001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: {
        path: '/health',  // 要確認：適切なヘルスチェックパス
        healthyHttpCodes: '200',
      },
    });

    // HTTPSリスナーの設定
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.forward([webTargetGroup]),
    });

    // HTTP to HTTPSリダイレクト
    const httpListener = alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    });

    // Route 53にALBのAliasレコードを作成
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(alb)
      ),
      recordName: this.DOMAIN
    });

    // APIルートの追加（優先順位の高い順に設定）
    httpsListener.addAction('ConsoleApiRoute', {
      priority: 10,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/console/api/*']),
      ],
      action: elbv2.ListenerAction.forward([apiTargetGroup]),
    });

    httpsListener.addAction('ApiRoute', {
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*']),
      ],
      action: elbv2.ListenerAction.forward([apiTargetGroup]),
    });

    httpsListener.addAction('V1Route', {
      priority: 30,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/v1/*']),
      ],
      action: elbv2.ListenerAction.forward([apiTargetGroup]),
    });

    httpsListener.addAction('FilesRoute', {
      priority: 40,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/files/*']),
      ],
      action: elbv2.ListenerAction.forward([apiTargetGroup]),
    });

    // CfnOutputでアクセスするURLを出力
    new cdk.CfnOutput(this, 'AccessURL', {
      value: `${elbv2.ApplicationProtocol.HTTPS.toLowerCase()}://${hostedZone.zoneName}`,
      description: 'Application Access URL'
    });

  }
}
