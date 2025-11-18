import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import IDL from "./raffle_platform.json";

export const PROGRAM_ID = new PublicKey("9Vu2g7S8oxYbk3JmHzjQXdoHguwEwPgVDq6KxAKAGWiW");
export const DEVNET_ENDPOINT = "https://api.devnet.solana.com";

export function getProgram(provider: AnchorProvider) {
  return new Program(IDL as any, provider) as any;
}

export function getRafflePda(creator: PublicKey, raffleId: bigint) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("raffle"),
      creator.toBuffer(),
      Buffer.from(new BigUint64Array([raffleId]).buffer),
    ],
    PROGRAM_ID
  );
}

export function getTicketPda(raffle: PublicKey, ticketNumber: number) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("ticket"),
      raffle.toBuffer(),
      Buffer.from(new Uint32Array([ticketNumber]).buffer),
    ],
    PROGRAM_ID
  );
}
