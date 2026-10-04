import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../deploy/ops-hms-proof.sh', import.meta.url), 'utf8');
const prefix = 'hms-browser-proof-transfer/v1/';
const rule = (id: string, objectPrefix: string, extra: Record<string, unknown>) => ({
  ID: id,
  Status: 'Enabled',
  Filter: { Prefix: objectPrefix },
  ...extra,
});
const policy = () => ({
  TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
  Rules: [
    rule('archive-raw-mime-30d', 'raw-mime/', {
      Transitions: [{ Days: 30, StorageClass: 'INTELLIGENT_TIERING' }],
    }),
    rule('archive-attachments-30d', 'attachments/', {
      Transitions: [{ Days: 30, StorageClass: 'INTELLIGENT_TIERING' }],
    }),
    rule('abort-incomplete-multipart-1d', '', {
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    }),
    rule('HmsBrowserProofTransferExpire1Day', prefix, {
      Expiration: { Days: 1 },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    }),
    rule('unrelated-scratch-cleanup', 'scratch/', { Expiration: { Days: 7 } }),
  ],
});

function runGuard(
  name: string,
  lifecycle: ReturnType<typeof policy>,
  tiering: Record<string, unknown> = { IsTruncated: false },
) {
  const block = script.split(`${name}() {`)[1]?.split('\n}\n')[0];
  const program = block?.match(/node -e '([\s\S]*?)\n'/)?.[1];
  if (!program) throw new Error(`Missing production lifecycle guard: ${name}`);
  return spawnSync(process.execPath, ['-e', program], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LIFECYCLE_JSON: JSON.stringify(lifecycle),
      INTELLIGENT_TIERING_JSON: JSON.stringify(tiering),
      PUBLIC_BLOCK_JSON: JSON.stringify({
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
      VERSIONING_JSON: '{}',
      TRANSFER_ROOT_VALUE: prefix,
    },
  });
}

describe('mail lifecycle retention guards', () => {
  for (const name of ['verify_transfer_bucket_policy', 'ensure_transfer_lifecycle_rule']) {
    it(`${name}: accepts retained mail and unrelated temporary-file cleanup`, () => {
      const result = runGuard(name, policy());
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    for (const accessTier of ['ARCHIVE_ACCESS', 'DEEP_ARCHIVE_ACCESS']) {
      it(`${name}: rejects optional ${accessTier} for mail`, () => {
        expect(
          runGuard(name, policy(), {
            IsTruncated: false,
            IntelligentTieringConfigurationList: [
              {
                Id: 'unsafe-optional-archive',
                Status: 'Enabled',
                Filter: { Prefix: 'raw-mime/' },
                Tierings: [{ Days: 180, AccessTier: accessTier }],
              },
            ],
          }).status,
        ).toBe(1);
      });
    }

    it(`${name}: rejects incomplete optional tier enumeration`, () => {
      expect(runGuard(name, policy(), { IsTruncated: true }).status).toBe(1);
    });

    it(`${name}: permits unrelated optional archive configurations`, () => {
      expect(
        runGuard(name, policy(), {
          IsTruncated: false,
          IntelligentTieringConfigurationList: [
            {
              Id: 'scratch-archive',
              Status: 'Enabled',
              Filter: { Prefix: 'scratch/' },
              Tierings: [{ Days: 180, AccessTier: 'DEEP_ARCHIVE_ACCESS' }],
            },
          ],
        }).status,
      ).toBe(0);
    });

    it(`${name}: rejects missing transition default instead of guessing`, () => {
      const current = policy();
      Object.assign(current, { TransitionDefaultMinimumObjectSize: undefined });
      expect(runGuard(name, current).status).toBe(1);
    });

    it(`${name}: rejects the old mail deletion policies`, () => {
      const current = policy();
      current.Rules[0] = rule('expire-raw-mime-30d', 'raw-mime/', { Expiration: { Days: 30 } });
      current.Rules[1] = rule('expire-attachments-90d', 'attachments/', {
        Expiration: { Days: 90 },
      });
      expect(runGuard(name, current).status).toBe(1);
    });

    for (const overlappingPrefix of ['', 'raw-mime/', 'attachments/hotel/', 'outlook-sync-originals/', 'outlook-sync-originals/v1/hotel/']) {
      it(`${name}: rejects overlapping mail expiration at ${JSON.stringify(overlappingPrefix)}`, () => {
        const current = policy();
        current.Rules.push(
          rule('unexpected-expiration', overlappingPrefix, { Expiration: { Days: 365 } }),
        );
        expect(runGuard(name, current).status).toBe(1);
      });
    }

    it(`${name}: rejects restore-required storage for retained mail`, () => {
      const current = policy();
      current.Rules[0] = rule('archive-raw-mime-30d', 'raw-mime/', {
        Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
      });
      expect(runGuard(name, current).status).toBe(1);
    });

    for (const storageClass of ['GLACIER', 'DEEP_ARCHIVE']) {
      it(`${name}: rejects an additional overlapping ${storageClass} transition`, () => {
        const current = policy();
        current.Rules.push(
          rule('unsafe-overlapping-transition', 'attachments/', {
            Transitions: [{ Days: 180, StorageClass: storageClass }],
          }),
        );
        expect(runGuard(name, current).status).toBe(1);
      });
    }

    for (const unsafeRule of [
      rule('noncurrent-expiration', 'raw-mime/', {
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      }),
      rule('and-expiration', 'attachments/', {
        Filter: { And: { Prefix: 'attachments/', Tags: [{ Key: 'hotel', Value: 'centurion' }] } },
        Expiration: { Days: 365 },
      }),
      rule('legacy-expiration', 'raw-mime/', {
        Filter: undefined,
        Prefix: 'raw-mime/',
        Expiration: { Days: 365 },
      }),
    ]) {
      it(`${name}: rejects ${unsafeRule.ID}`, () => {
        const current = policy();
        current.Rules.push(unsafeRule);
        expect(runGuard(name, current).status).toBe(1);
      });
    }

    it(`${name}: permits a disabled overlapping expiry rule`, () => {
      const current = policy();
      current.Rules.push(
        rule('disabled-expiration', '', { Status: 'Disabled', Expiration: { Days: 1 } }),
      );
      expect(runGuard(name, current).status).toBe(0);
    });

    it(`${name}: rejects an overlapping noncurrent Glacier transition`, () => {
      const current = policy();
      current.Rules.push(
        rule('unsafe-noncurrent-transition', 'raw-mime/', {
          NoncurrentVersionTransitions: [{ NoncurrentDays: 180, StorageClass: 'GLACIER' }],
        }),
      );
      expect(runGuard(name, current).status).toBe(1);
    });
  }

  it('adding the temporary-proof rule preserves every existing mail rule and transition default', () => {
    const current = policy();
    current.Rules = current.Rules.filter(
      (entry) => entry.ID !== 'HmsBrowserProofTransferExpire1Day',
    );
    const result = runGuard('ensure_transfer_lifecycle_rule', current);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const merged = JSON.parse(result.stdout);
    expect(merged.changed).toBe(true);
    expect(merged.minimumObjectSize).toBe(current.TransitionDefaultMinimumObjectSize);
    expect(merged.configuration.Rules.slice(0, -1)).toEqual(current.Rules);
    expect(merged.configuration.Rules.at(-1)).toEqual(
      rule('HmsBrowserProofTransferExpire1Day', prefix, {
        Expiration: { Days: 1 },
      }),
    );
  });

  it('the resource bootstrap retains MIME and attachments instead of expiring them', () => {
    const resources = readFileSync(new URL('../deploy/aws-resources.md', import.meta.url), 'utf8');
    const match = resources.match(/--lifecycle-configuration '(\{"Rules":.*\})'/);
    expect(match).not.toBeNull();
    const configured = JSON.parse(match![1]);
    for (const mailPrefix of ['raw-mime/', 'attachments/', 'outlook-sync-originals/v1/']) {
      const matched = configured.Rules.filter(
        (entry: { Filter?: { Prefix?: string } }) => entry.Filter?.Prefix === mailPrefix,
      );
      expect(matched).toHaveLength(1);
      expect(matched[0].Expiration).toBeUndefined();
      expect(matched[0].Transitions).toEqual([{ Days: 30, StorageClass: 'INTELLIGENT_TIERING' }]);
    }
  });

  it('sync staging expires after seven days while committed sync originals are retained', () => {
    const resources = readFileSync(new URL('../deploy/aws-resources.md', import.meta.url), 'utf8');
    const match = resources.match(/--lifecycle-configuration '(\{"Rules":.*\})'/);
    const configured = JSON.parse(match![1]);
    const staging = configured.Rules.find((entry: any) => entry.Filter?.Prefix === 'outlook-sync-staging/v1/');
    expect(staging.Expiration.Days).toBe(7);
    expect(staging.AbortIncompleteMultipartUpload.DaysAfterInitiation).toBe(1);
  });
  it('the shell merge forwards the original transition minimum and preserved rules to AWS', () => {
    const current = policy();
    current.Rules = current.Rules.filter(
      (entry) => entry.ID !== 'HmsBrowserProofTransferExpire1Day',
    );
    const body = script.split('ensure_transfer_lifecycle_rule() {')[1]?.split('\n}\n')[0];
    if (!body) throw new Error('Missing lifecycle merge shell function');
    // Replace only the external AWS transport; execute the real shell/Node merge code.
    const program = `set -eu
aws() {
  case "$*" in
    *get-bucket-lifecycle-configuration*) printf '%s\\n' "$TEST_POLICY_JSON" ;;
    *list-bucket-intelligent-tiering-configurations*) printf '%s\\n' '{"IsTruncated":false}' ;;
    *put-bucket-lifecycle-configuration*) printf '%s\\n' "$@" >&2 ;;
    *) return 99 ;;
  esac
}
ensure_transfer_lifecycle_rule() {${body}
}
ensure_transfer_lifecycle_rule
`;
    // The production function redirects AWS stdout; use stderr for intercepted argv.
    const result = spawnSync('bash', ['-c', program], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_POLICY_JSON: JSON.stringify(current),
        TRANSFER_ROOT: prefix,
        TRANSFER_BUCKET: 'test-mail-retention',
        AWS_REGION: 'af-south-1',
      },
    });
    expect(result.status).toBe(0);
    const args = result.stderr.trim().split('\n');
    expect(args.slice(0, 2)).toEqual(['s3api', 'put-bucket-lifecycle-configuration']);
    expect(args[args.indexOf('--transition-default-minimum-object-size') + 1]).toBe(
      current.TransitionDefaultMinimumObjectSize,
    );
    const merged = JSON.parse(args[args.indexOf('--lifecycle-configuration') + 1]);
    expect(merged.Rules.slice(0, -1)).toEqual(current.Rules);
  });
});
