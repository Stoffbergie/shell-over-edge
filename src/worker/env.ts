export type Env = {
  SOE_MAILBOX: R2Bucket;
  COMMAND_BRIDGES: DurableObjectNamespace;
  BASE_URL?: string;
  ENABLE_LEGACY_BRIDGE?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_CREDENTIAL_TTL_SECONDS?: string;
  TURN_API_BASE_URL?: string;
};
