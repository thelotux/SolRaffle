import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export type RafflePlatform = {
  version: string;
  name: string;
  instructions: any[];
  accounts: any[];
  types: any[];
};
