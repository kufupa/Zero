# CloudWatch Alarms — NAVA Zero server-pilot

Documented CLI for pilot alarms (Task 12). Run from laptop or EC2 with AWS CLI configured for `af-south-1`.

Identifiers from [`aws-resources.md`](./aws-resources.md):

| Variable | Value |
|----------|-------|
| `AWS_REGION` | `af-south-1` |
| `EC2_INSTANCE_ID` | `i-008f737974a9ba9b3` |
| `RDS_DB_ID` | `nava-zero-mail-pilot` |
| Metric namespace (worker) | `Zero/ServerPilot` |

Set a human notification target before creating alarms:

```bash
export AWS_REGION=af-south-1
export EC2_INSTANCE_ID=i-008f737974a9ba9b3
export RDS_DB_ID=nava-zero-mail-pilot
export ALARM_SNS_ARN=arn:aws:sns:af-south-1:845242190536:nava-zero-pilot-alarms
```

Create the SNS topic + email subscription once (human step):

```bash
aws sns create-topic --region "$AWS_REGION" --name nava-zero-pilot-alarms
aws sns subscribe --region "$AWS_REGION" \
  --topic-arn "$ALARM_SNS_ARN" \
  --protocol email \
  --notification-endpoint you@example.com
```

Common alarm actions block (append to each `put-metric-alarm`):

```bash
--alarm-actions "$ALARM_SNS_ARN" \
--ok-actions "$ALARM_SNS_ARN" \
--treat-missing-data notBreaching
```

## EC2 CPU > 80%

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-ec2-cpu-high \
  --alarm-description "EC2 CPU > 80% for 15 minutes" \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value="$EC2_INSTANCE_ID" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 3 \
  --datapoints-to-alarm 3 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## EC2 memory > 80% (requires CloudWatch Agent)

Install and configure the CloudWatch Agent on EC2 to publish `mem_used_percent` under `CWAgent` before this alarm is meaningful.

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-ec2-memory-high \
  --alarm-description "EC2 memory > 80% for 15 minutes (CWAgent mem_used_percent)" \
  --namespace CWAgent \
  --metric-name mem_used_percent \
  --dimensions Name=InstanceId,Value="$EC2_INSTANCE_ID" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 3 \
  --datapoints-to-alarm 3 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## RDS CPU > 80%

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-rds-cpu-high \
  --alarm-description "RDS CPU > 80% for 15 minutes" \
  --namespace AWS/RDS \
  --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value="$RDS_DB_ID" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 3 \
  --datapoints-to-alarm 3 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## RDS FreeableMemory low

Alert when freeable memory drops below ~256 MiB (adjust for instance class).

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-rds-freeable-memory-low \
  --alarm-description "RDS FreeableMemory below 256 MiB" \
  --namespace AWS/RDS \
  --metric-name FreeableMemory \
  --dimensions Name=DBInstanceIdentifier,Value="$RDS_DB_ID" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 268435456 \
  --comparison-operator LessThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## RDS DatabaseConnections high

Threshold ~80% of `max_connections` on `db.t4g.medium` (adjust after checking `SHOW max_connections`).

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-rds-connections-high \
  --alarm-description "RDS DatabaseConnections > 80 for 10 minutes" \
  --namespace AWS/RDS \
  --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value="$RDS_DB_ID" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## RDS CPUCreditBalance low (burstable class)

`db.t4g.medium` is burstable. Page when CPU credits are nearly exhausted.

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-rds-cpu-credits-low \
  --alarm-description "RDS CPUCreditBalance below 100" \
  --namespace AWS/RDS \
  --metric-name CPUCreditBalance \
  --dimensions Name=DBInstanceIdentifier,Value="$RDS_DB_ID" \
  --statistic Minimum \
  --period 300 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 100 \
  --comparison-operator LessThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## Worker LastSuccessfulPollAgeSeconds > 900

Requires the worker to emit `LastSuccessfulPollAgeSeconds` into `Zero/ServerPilot` (Task 13 metrics). Alarm fires when the last successful poll is stale for 15+ minutes.

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-worker-poll-stale \
  --alarm-description "Worker LastSuccessfulPollAgeSeconds > 900" \
  --namespace Zero/ServerPilot \
  --metric-name LastSuccessfulPollAgeSeconds \
  --statistic Maximum \
  --period 300 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 900 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data breaching
```

## UIDL backlog grows 3 polls

Uses a CloudWatch Metrics Math alarm: current `UidlBacklog` greater than value 3 polls ago. Requires worker to publish `UidlBacklog` each cycle.

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-worker-uidl-backlog-growing \
  --alarm-description "UidlBacklog increased over 3 consecutive 30s polls" \
  --metrics '[
    {"Id":"m1","MetricStat":{"Metric":{"Namespace":"Zero/ServerPilot","MetricName":"UidlBacklog"},"Period":30,"Stat":"Maximum"}},
    {"Id":"m2","ReturnData":false,"MetricStat":{"Metric":{"Namespace":"Zero/ServerPilot","MetricName":"UidlBacklog"},"Period":30,"Stat":"Maximum"}},
    {"Id":"e1","Expression":"m1 - LOOKUP(m2, -2)","Label":"BacklogDelta3Polls","ReturnData":true}
  ]' \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 3 \
  --datapoints-to-alarm 3 \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

Simpler alternative if math alarm is awkward: alert when `UidlBacklog` exceeds a fixed ceiling (e.g. 50 messages).

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-worker-uidl-backlog-high \
  --alarm-description "UidlBacklog > 50" \
  --namespace Zero/ServerPilot \
  --metric-name UidlBacklog \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 3 \
  --datapoints-to-alarm 3 \
  --threshold 50 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## Quarantine count > 0

Emit `QuarantinedCount` (or `QuarantinedMissingOwner`) from worker/store after each cycle, or run a periodic custom metric from cron querying `mail_ingest_quarantine`.

```bash
aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-ingest-quarantine \
  --alarm-description "Quarantined ingest messages > 0" \
  --namespace Zero/ServerPilot \
  --metric-name QuarantinedCount \
  --statistic Maximum \
  --period 300 \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## HTTP 5xx sustained

nginx does not expose 5xx to CloudWatch by default. Options:

1. **Application metric** — HTTP server emits `Http5xxCount` to `Zero/ServerPilot` each minute.
2. **ALB** — if an ALB is added in front of nginx, use `HTTPCode_Target_5XX_Count`.
3. **Log metric filter** — parse nginx access log on EC2.

Log metric filter example (nginx error log path may differ):

```bash
LOG_GROUP=/nava-zero/nginx
aws logs create-log-group --region "$AWS_REGION" --log-group-name "$LOG_GROUP" || true

aws logs put-metric-filter --region "$AWS_REGION" \
  --log-group-name "$LOG_GROUP" \
  --filter-name nava-zero-nginx-5xx \
  --filter-pattern '[... status=5* ...]' \
  --metric-transformations \
    metricName=Http5xxCount,metricNamespace=Zero/ServerPilot,metricValue=1,defaultValue=0

aws cloudwatch put-metric-alarm --region "$AWS_REGION" \
  --alarm-name nava-zero-http-5xx-sustained \
  --alarm-description "HTTP 5xx count > 0 for 5 minutes" \
  --namespace Zero/ServerPilot \
  --metric-name Http5xxCount \
  --statistic Sum \
  --period 60 \
  --evaluation-periods 5 \
  --datapoints-to-alarm 3 \
  --threshold 0 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ALARM_SNS_ARN" \
  --ok-actions "$ALARM_SNS_ARN" \
  --treat-missing-data notBreaching
```

## Verify alarms

```bash
aws cloudwatch describe-alarms --region "$AWS_REGION" \
  --alarm-name-prefix nava-zero- \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' \
  --output table
```

## IAM note

EC2 worker role needs `cloudwatch:PutMetricData` on `Zero/ServerPilot` when worker metrics are wired (Task 13). Alarm creation itself uses operator credentials, not the instance role.
