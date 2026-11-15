export const HMS_CREDENTIAL_MODES = ['view_only', 'audited_write', 'write_capable'] as const;
export type HmsCredentialMode = (typeof HMS_CREDENTIAL_MODES)[number];
