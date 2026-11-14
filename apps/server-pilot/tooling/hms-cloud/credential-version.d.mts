export declare function credentialVersionHmacSha256(input: {
  evidenceKey: string | Buffer;
  evidenceKeyVersion: string;
  hmsSecretArn: string;
  hmsSecretVersionId: string;
}): string;
