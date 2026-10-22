variable "aws_region" {
  type    = string
  default = "us-gov-west-1"
  validation {
    condition     = contains(["us-gov-west-1", "us-east-1", "us-east-2", "us-west-2"], var.aws_region)
    error_message = "Select a documented in-region US deployment for the exact requested Bedrock model."
  }
}

variable "aws_profile" {
  type        = string
  default     = null
  nullable    = true
  description = "Local AWS profile; leave null when using CI or workload IAM roles."
}

variable "aws_shared_credentials_files" {
  type        = list(string)
  default     = []
  description = "Local file paths only. Credential values must never enter Terraform."
}

variable "project" {
  type    = string
  default = "physical-ai"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,16}$", var.project))
    error_message = "Use 3-17 lowercase letters, digits or hyphens."
  }
}

variable "environment" {
  type    = string
  default = "dev"
  validation {
    condition     = contains(["dev", "stage", "prod"], var.environment)
    error_message = "Use dev, stage or prod."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "Use an IPv4 CIDR."
  }
}

variable "allowed_ingress_cidrs" {
  type        = set(string)
  description = "Approved client/VPN IPv4 ranges for HTTPS."
  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0 && alltrue([for cidr in var.allowed_ingress_cidrs : can(cidrnetmask(cidr))])
    error_message = "Provide at least one valid approved IPv4 CIDR."
  }
}

variable "service_domain" {
  type        = string
  description = "DNS name whose ACM certificate is already issued in this region."
  validation {
    condition     = can(regex("^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", var.service_domain))
    error_message = "Provide a DNS name, without scheme or path."
  }
}

variable "certificate_arn" {
  type        = string
  description = "Issued ACM certificate covering service_domain."
  validation {
    condition     = can(regex("^arn:[^:]+:acm:", var.certificate_arn))
    error_message = "Provide an ACM certificate ARN."
  }
}

variable "route53_zone_id" {
  type        = string
  default     = null
  nullable    = true
  description = "Optional public hosted zone for an ALB alias."
}

variable "oidc_issuer" {
  type = string
  validation {
    condition     = can(regex("^https://", var.oidc_issuer))
    error_message = "Use the organization HTTPS OIDC issuer."
  }
}

variable "oidc_audience" {
  type        = string
  description = "Resource API audience."
}

variable "oidc_client_id" {
  type        = string
  description = "Confidential web client identifier, distinct from the API audience."
}

variable "facility_id" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", var.facility_id))
    error_message = "Use a valid authorized facility identifier."
  }
}

variable "app_secret_arn" {
  type        = string
  description = "Existing Secrets Manager JSON containing OIDC_CLIENT_SECRET, SESSION_ENCRYPTION_KEY, DEVICE_KEYS_JSON, MODEL_REGISTRY_JSON and SAFETY_POLICY_JSON."
  validation {
    condition     = can(regex("^arn:[^:]+:secretsmanager:", var.app_secret_arn))
    error_message = "Provide a Secrets Manager ARN; never pass secret values."
  }
}

variable "additional_secret_kms_arns" {
  type        = list(string)
  default     = []
  description = "CMKs used by the supplied application secret, if any."
}

variable "deploy_service" {
  type        = bool
  default     = true
  description = "Run automatic database bootstrap and start one healthy ECS controller. Set false only for initial image-repository provisioning or planned maintenance."
}

variable "image_tag" {
  type    = string
  default = "release"
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "Use a valid immutable ECR image tag."
  }
}

variable "image_digest" {
  type     = string
  default  = null
  nullable = true
  validation {
    condition     = var.image_digest == null ? true : can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "Use an ECR sha256 digest."
  }
}

variable "task_cpu" {
  type    = number
  default = 512
  validation {
    condition     = var.task_cpu == 512
    error_message = "This tested task profile uses 512 CPU units."
  }
}

variable "task_memory" {
  type    = number
  default = 1024
  validation {
    condition     = var.task_memory == 1024
    error_message = "This tested task profile uses 1024 MiB."
  }
}

variable "database_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "database_multi_az" {
  type    = bool
  default = true
}

variable "database_deletion_protection" {
  type    = bool
  default = true
}

variable "final_snapshot_identifier" {
  type     = string
  default  = null
  nullable = true
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "bedrock_enabled" {
  type    = bool
  default = true
}
