resource "aws_kms_key" "app" {
  description         = "Physical AI simulation source, state and logs"
  enable_key_rotation = true
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Sid = "AccountAdministration", Effect = "Allow", Principal = { AWS = "arn:${local.partition}:iam::${local.account}:root" }, Action = "kms:*", Resource = "*" },
    { Sid = "RegionalLogs", Effect = "Allow", Principal = { Service = "logs.${var.aws_region}.amazonaws.com" }, Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"], Resource = "*", Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:${var.aws_region}:${local.account}:log-group:/physical-ai/${local.name}*" } } }
  ] })
}
resource "aws_kms_alias" "app" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.app.key_id
}
resource "aws_s3_bucket" "artifacts" {
  bucket        = "${local.name}-${local.account}-${var.aws_region}"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.app.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_s3_object" "source" {
  bucket                 = aws_s3_bucket.artifacts.id
  key                    = "source/${local.source_hash}.zip"
  source                 = local.source_path
  source_hash            = local.source_hash
  server_side_encryption = "aws:kms"
  kms_key_id             = aws_kms_key.app.arn
  depends_on             = [aws_s3_bucket_versioning.artifacts, aws_s3_bucket_public_access_block.artifacts]
}
resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.app.arn
  }
  image_scanning_configuration {
    scan_on_push = true
  }
}
resource "aws_cloudwatch_log_group" "build" {
  name              = "/physical-ai/${local.name}/build"
  retention_in_days = 30
  kms_key_id        = aws_kms_key.app.arn
}
resource "aws_iam_role" "build" {
  name               = "${local.name}-build"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "codebuild.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = { "aws:SourceArn" = "arn:${local.partition}:codebuild:${var.aws_region}:${local.account}:project/${local.name}" } } }] })
}
resource "aws_iam_role_policy" "build" {
  role = aws_iam_role.build.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = [aws_cloudwatch_log_group.build.arn, "${aws_cloudwatch_log_group.build.arn}:log-stream:*"] },
    { Effect = "Allow", Action = ["s3:GetBucketLocation", "s3:GetBucketAcl"], Resource = aws_s3_bucket.artifacts.arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = aws_s3_object.source.arn },
    { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.app.arn },
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource = aws_ecr_repository.app.arn }
  ] })
}
resource "aws_codebuild_project" "app" {
  name          = local.name
  service_role  = aws_iam_role.build.arn
  build_timeout = 30
  artifacts {
    type = "NO_ARTIFACTS"
  }
  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type                        = "LINUX_CONTAINER"
    privileged_mode             = true
    image_pull_credentials_type = "CODEBUILD"
    environment_variable {
      name  = "IMAGE_URI"
      value = local.image_uri
    }
    environment_variable {
      name  = "ECR_REGISTRY"
      value = split("/", aws_ecr_repository.app.repository_url)[0]
    }
  }
  source {
    type     = "S3"
    location = "${aws_s3_bucket.artifacts.id}/${aws_s3_object.source.key}"
    buildspec = yamlencode({ version = "0.2", phases = {
      pre_build  = { commands = ["docker info", "aws ecr get-login-password --region \"$AWS_DEFAULT_REGION\" | docker login --username AWS --password-stdin \"$ECR_REGISTRY\""] }
      build      = { commands = ["docker build --platform linux/amd64 --file Dockerfile.simulation -t \"$IMAGE_URI\" ."] }
      post_build = { commands = ["docker push \"$IMAGE_URI\""] }
    } })
  }
  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.build.name
      status     = "ENABLED"
    }
  }
  depends_on = [aws_iam_role_policy.build]
}
action "aws_codebuild_start_build" "image" {
  config {
    project_name = aws_codebuild_project.app.name
    timeout      = 1800
  }
}
resource "terraform_data" "image" {
  input = local.source_hash
  lifecycle {
    action_trigger {
      events  = [before_create, before_update]
      actions = [action.aws_codebuild_start_build.image]
    }
  }
  depends_on = [aws_codebuild_project.app, aws_s3_object.source]
}
data "aws_ecr_image" "release" {
  repository_name = aws_ecr_repository.app.name
  image_tag       = local.image_tag
  depends_on      = [terraform_data.image]
}
