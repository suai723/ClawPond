import { ChannelSecurityAdapter, ClawPondAccount } from "./types.js";

export const securityAdapter: ChannelSecurityAdapter = {
  /** ClawPond rooms are group-only; treat all messages as open */
  getDmPolicy(_account: ClawPondAccount): "open" | "pairing" | "closed" {
    return "open";
  },

  /** No allow-list filtering by default */
  getAllowFrom(_account: ClawPondAccount): string[] {
    return [];
  },
};
