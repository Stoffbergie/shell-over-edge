export type Env = {
  SOE_MAILBOX: R2Bucket;
  COMMAND_BRIDGES: DurableObjectNamespace;
  BASE_URL?: string;
  ENABLE_LEGACY_BRIDGE?: string;
};
