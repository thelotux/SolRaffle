"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getProgram, getRafflePda, getTicketPda } from "@/utils/program";
import { addRaffleToHistory, getRaffleHistory, clearHistory, type RaffleHistoryEntry } from "@/utils/raffleHistory";

interface RaffleState {
  active?: {};
  ended?: {};
  completed?: {};
}

interface Raffle {
  creator: PublicKey;
  ticketPrice: BN;
  maxTickets: number;
  endTime: BN;
  totalTicketsSold: number;
  ticketBuyers: PublicKey[];
  winner: PublicKey | null;
  state: RaffleState;
  bump: number;
  raffleId: BN;
  address: PublicKey;
}

export default function RafflePlatform() {
  const { connection } = useConnection();
  const wallet = useWallet();

  // State for mounting check (prevent hydration issues)
  const [mounted, setMounted] = useState(false);

  // State for Create Raffle
  const [raffleId, setRaffleId] = useState("");
  const [ticketPrice, setTicketPrice] = useState("");
  const [maxTickets, setMaxTickets] = useState("");
  const [endTime, setEndTime] = useState("");

  // State for Buy Ticket
  const [buyRaffleAddress, setBuyRaffleAddress] = useState("");

  // State for Draw Winner
  const [drawRaffleAddress, setDrawRaffleAddress] = useState("");

  // State for raffles list
  const [raffles, setRaffles] = useState<Raffle[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState<"active" | "history">("active");
  const [history, setHistory] = useState<RaffleHistoryEntry[]>([]);

  // Ref to prevent concurrent fetches
  const isFetchingRef = useRef(false);

  // Set mounted on client side only
  useEffect(() => {
    setMounted(true);
    // Load history from localStorage
    setHistory(getRaffleHistory());
  }, []);

  const getProvider = useCallback(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
      return null;
    }
    return new AnchorProvider(
      connection,
      wallet as any,
      { commitment: "confirmed" }
    );
  }, [connection, wallet]);

  const fetchRaffles = useCallback(async () => {
    // Prevent concurrent fetches
    if (isFetchingRef.current) {
      console.log("Already fetching, skipping...");
      return;
    }

    try {
      isFetchingRef.current = true;
      setLoading(true);

      const provider = getProvider();
      if (!provider) {
        setLoading(false);
        isFetchingRef.current = false;
        return;
      }

      const program = getProgram(provider);

      console.log("Starting to fetch raffles with RPC limit...");

      // Use direct RPC call with dataSlice to limit data returned
      // This prevents hanging when there are too many accounts
      const programId = program.programId;

      console.log("Fetching program accounts...");
      // Filter for raffle accounts with correct size (max_len = 20)
      // 8 (discriminator) + 32 (creator) + 8 (ticket_price) + 4 (max_tickets) +
      // 8 (end_time) + 4 (total_tickets_sold) + 4 (vec length) + 32*20 (ticket_buyers) +
      // 1+32 (option winner) + 1 (state) + 1 (bump) + 8 (raffle_id) = 8+32+8+4+8+4+4+640+33+1+1+8 = 751
      const raffleAccountSize = 751;

      const accounts = await connection.getProgramAccounts(programId, {
        commitment: 'confirmed',
        filters: [
          {
            dataSize: raffleAccountSize,
          },
        ],
      });

      console.log(`✓ Found ${accounts.length} raffle accounts`);

      // Fetch each account individually (only first 50)
      const raffleData: Raffle[] = [];
      const fetchPromises: Promise<void>[] = [];

      for (let i = 0; i < Math.min(accounts.length, 50); i++) {
        const account = accounts[i];

        fetchPromises.push(
          (async () => {
            try {
              // @ts-ignore
              const decoded = await program.account.raffle.fetch(account.pubkey);

              // Include Active and Ended raffles (exclude Completed)
              if (decoded.state && typeof decoded.state === 'object') {
                const isActive = 'active' in decoded.state;
                const isEnded = 'ended' in decoded.state;
                const isCompleted = 'completed' in decoded.state;

                if ((isActive || isEnded) && !isCompleted) {
                  // Debug: log first raffle data to check ticketPrice type
                  if (raffleData.length === 0) {
                    console.log("First raffle ticketPrice:", {
                      value: decoded.ticketPrice,
                      type: typeof decoded.ticketPrice,
                      isBN: decoded.ticketPrice instanceof BN,
                      toNumber: typeof decoded.ticketPrice?.toNumber,
                    });
                  }

                  raffleData.push({
                    address: account.pubkey,
                    ...decoded,
                  });
                }
              }
            } catch (err) {
              console.log(`Skipping account ${i}: ${err}`);
            }
          })()
        );
      }

      await Promise.all(fetchPromises);

      console.log(`✓ Decoded ${raffleData.length} active raffles`);
      setRaffles(raffleData);
    } catch (error: any) {
      console.error("❌ Error fetching raffles:", error);
      console.error("Error message:", error?.message);
      setRaffles([]);
      setMessage(`Error: ${error?.message || "Failed to fetch raffles"}`);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, [getProvider, connection]);

  // Auto-fetch when wallet connects
  useEffect(() => {
    if (wallet.publicKey && mounted && !isFetchingRef.current) {
      fetchRaffles();
    }
    // Only depend on wallet.publicKey and mounted to prevent loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.publicKey, mounted]);

  const handleCreateRaffle = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!wallet.publicKey) {
      setMessage("Please connect your wallet first!");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not available");
      }

      const program = getProgram(provider);
      const raffleIdBN = new BN(raffleId);
      const ticketPriceLamports = Math.floor(parseFloat(ticketPrice) * LAMPORTS_PER_SOL);
      const ticketPriceBN = new BN(ticketPriceLamports);
      const maxTicketsNum = parseInt(maxTickets);
      const endTimeBN = new BN(Math.floor(new Date(endTime).getTime() / 1000));

      console.log("Creating raffle with:", {
        raffleId: raffleIdBN.toString(),
        ticketPrice: ticketPriceBN.toString(),
        maxTickets: maxTicketsNum,
        endTime: endTimeBN.toString(),
        creator: wallet.publicKey.toString(),
      });

      const [rafflePda] = getRafflePda(wallet.publicKey, BigInt(raffleIdBN.toString()));
      console.log("Raffle PDA:", rafflePda.toString());

      const tx = await program.methods
        .createRaffle(raffleIdBN, ticketPriceBN, maxTicketsNum, endTimeBN)
        .accounts({
          raffle: rafflePda,
          creator: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Wait for transaction confirmation
      await provider.connection.confirmTransaction(tx, "confirmed");

      setMessage("✅ Raffle created successfully!");
      setRaffleId("");
      setTicketPrice("");
      setMaxTickets("");
      setEndTime("");

      // Wait a bit before refreshing to ensure state is updated
      setTimeout(() => {
        fetchRaffles();
      }, 1500);
    } catch (error: any) {
      console.error("Full error object:", error);
      console.error("Error logs:", error.logs);
      console.error("Error name:", error.name);
      console.error("Error code:", error.code);

      let errorMsg = "Unknown error";

      if (error.name === "WalletSignTransactionError") {
        errorMsg = "Transaction rejected by wallet. Please approve the transaction in your wallet.";
      } else if (error.message?.includes("insufficient")) {
        errorMsg = "Insufficient SOL balance. Please add more SOL to your wallet.";
      } else if (error.message) {
        errorMsg = error.message;
      } else {
        errorMsg = error.toString();
      }

      setMessage(`❌ Error: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleBuyTicket = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!wallet.publicKey) {
      setMessage("Please connect your wallet first!");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not available");
      }

      const program = getProgram(provider);
      const rafflePubkey = new PublicKey(buyRaffleAddress);

      // Fetch fresh raffle data to get current ticket count
      const raffleAccount = await program.account.raffle.fetch(rafflePubkey);
      const ticketNumber = raffleAccount.totalTicketsSold;

      const [ticketPda] = getTicketPda(rafflePubkey, ticketNumber);

      // Send transaction with confirmation
      const tx = await program.methods
        .buyTicket()
        .accounts({
          raffle: rafflePubkey,
          ticket: ticketPda,
          buyer: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // Wait for confirmation
      await provider.connection.confirmTransaction(tx, "confirmed");

      setMessage(`✅ Ticket #${ticketNumber} purchased successfully!`);
      setBuyRaffleAddress("");

      // Wait a bit before refreshing to ensure state is updated
      setTimeout(() => {
        fetchRaffles();
      }, 1000);
    } catch (error: any) {
      console.error("Error buying ticket:", error);

      // Provide more helpful error messages
      let errorMsg = error.message;
      if (error.message?.includes("already in use")) {
        errorMsg = "Transaction in progress or ticket already purchased. Please wait a moment and try again.";
      }

      setMessage(`❌ Error: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDrawWinner = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!wallet.publicKey) {
      setMessage("Please connect your wallet first!");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const provider = getProvider();
      if (!provider) {
        throw new Error("Provider not available");
      }

      const program = getProgram(provider);
      const rafflePubkey = new PublicKey(drawRaffleAddress);

      const raffleAccount = await program.account.raffle.fetch(rafflePubkey);

      console.log("Raffle state before draw:", {
        state: raffleAccount.state,
        tickets: raffleAccount.totalTicketsSold,
        winner: raffleAccount.winner?.toString() || 'none'
      });

      if (raffleAccount.totalTicketsSold === 0) {
        throw new Error("No tickets sold yet!");
      }

      // Program uses slot-based randomness - winner determined by blockchain slot
      // Pass all ticket buyers as remaining accounts so program can find the winner
      console.log("Drawing winner with slot-based randomness...");
      console.log(`Total ticket buyers to pass: ${raffleAccount.ticketBuyers.length}`);

      // Prepare remaining accounts array with all ticket buyers
      const remainingAccounts = raffleAccount.ticketBuyers.map((buyer: any) => ({
        pubkey: buyer,
        isSigner: false,
        isWritable: true, // Winner will receive lamports
      }));

      // Also add the creator account to remaining accounts
      remainingAccounts.push({
        pubkey: raffleAccount.creator,
        isSigner: false,
        isWritable: true, // Creator receives fee
      });

      // Send transaction with all possible winners as remaining accounts
      const tx = await program.methods
        .drawWinner()
        .accounts({
          raffle: rafflePubkey,
          creator: raffleAccount.creator,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts(remainingAccounts)
        .rpc();

      // Confirm transaction
      await provider.connection.confirmTransaction(tx, "confirmed");

      // Get transaction details to find the actual slot used
      const txDetails = await provider.connection.getTransaction(tx, {
        maxSupportedTransactionVersion: 0,
      });

      if (!txDetails || !txDetails.slot) {
        throw new Error("Could not fetch transaction details");
      }

      // Calculate actual winner using the transaction slot (same as on-chain program)
      const actualWinningIndex = txDetails.slot % raffleAccount.totalTicketsSold;
      const actualWinner = raffleAccount.ticketBuyers[actualWinningIndex];

      console.log(`✅ Success! Transaction slot: ${txDetails.slot}`);
      console.log(`✅ Winner: ${actualWinner.toString()}, ticket #${actualWinningIndex}`);

      // Save to history
      const historyEntry: RaffleHistoryEntry = {
        raffleId: raffleAccount.raffleId.toString(),
        raffleAddress: rafflePubkey.toString(),
        creator: raffleAccount.creator.toString(),
        ticketPrice: raffleAccount.ticketPrice.toNumber() / LAMPORTS_PER_SOL,
        maxTickets: raffleAccount.maxTickets,
        totalTicketsSold: raffleAccount.totalTicketsSold,
        endTime: raffleAccount.endTime.toNumber(),
        winner: actualWinner.toString(),
        winningTicketNumber: actualWinningIndex,
        completedAt: Date.now(),
        transactionSignature: tx,
      };
      addRaffleToHistory(historyEntry);
      setHistory(getRaffleHistory());

      setMessage(`✅ Winner drawn! Ticket #${actualWinningIndex} wins! Check history for details.`);
      setDrawRaffleAddress("");

      // Note: Raffle account is now closed (all lamports distributed)
      // No need to fetch final state as account no longer exists

      await fetchRaffles();
      console.log("Raffles refreshed successfully");
    } catch (error: any) {
      console.error("Error drawing winner:", error);
      setMessage(`❌ Error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  // Prevent hydration issues by only rendering on client
  if (!mounted) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Status Message */}
      {message && (
        <div className={`p-4 rounded-lg ${message.includes("✅") ? "bg-green-900/50" : "bg-red-900/50"}`}>
          <p className="text-white">{message}</p>
        </div>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Create Raffle Card */}
        <div className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-xl border border-purple-500/20 shadow-lg">
          <h2 className="text-2xl font-bold text-purple-400 mb-4">Create Raffle</h2>
          <form onSubmit={handleCreateRaffle} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Raffle ID
              </label>
              <input
                type="number"
                value={raffleId}
                onChange={(e) => setRaffleId(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                required
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Ticket Price (SOL)
              </label>
              <input
                type="number"
                step="0.01"
                value={ticketPrice}
                onChange={(e) => setTicketPrice(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                required
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Max Tickets
              </label>
              <input
                type="number"
                value={maxTickets}
                onChange={(e) => setMaxTickets(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                required
                disabled={loading}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                End Time
              </label>
              <input
                type="datetime-local"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                required
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              disabled={loading || !wallet.publicKey}
              className="w-full py-3 bg-gradient-to-r from-purple-600 to-pink-600 text-white font-semibold rounded-lg hover:from-purple-700 hover:to-pink-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? "Creating..." : "Create Raffle"}
            </button>
          </form>
        </div>

        {/* Buy Ticket Card */}
        <div className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-xl border border-purple-500/20 shadow-lg">
          <h2 className="text-2xl font-bold text-purple-400 mb-4">Buy Ticket</h2>
          <form onSubmit={handleBuyTicket} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Raffle Address
              </label>
              <input
                type="text"
                value={buyRaffleAddress}
                onChange={(e) => setBuyRaffleAddress(e.target.value)}
                placeholder="Enter raffle public key"
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                required
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              disabled={loading || !wallet.publicKey}
              className="w-full py-3 bg-gradient-to-r from-blue-600 to-cyan-600 text-white font-semibold rounded-lg hover:from-blue-700 hover:to-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? "Buying..." : "Buy Ticket"}
            </button>
          </form>
        </div>

        {/* Draw Winner Card */}
        <div className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-xl border border-purple-500/20 shadow-lg">
          <h2 className="text-2xl font-bold text-purple-400 mb-4">Draw Winner</h2>
          <p className="text-sm text-gray-400 mb-4">
            Anyone can draw the winner after the raffle ends (time passed OR all tickets sold)
          </p>
          <form onSubmit={handleDrawWinner} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Raffle Address
              </label>
              <input
                type="text"
                value={drawRaffleAddress}
                onChange={(e) => setDrawRaffleAddress(e.target.value)}
                placeholder="Enter raffle public key"
                className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:border-purple-500"
                required
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              disabled={loading || !wallet.publicKey}
              className="w-full py-3 bg-gradient-to-r from-green-600 to-emerald-600 text-white font-semibold rounded-lg hover:from-green-700 hover:to-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? "Drawing..." : "Draw Winner"}
            </button>
          </form>
        </div>
      </div>

      {/* Raffles List */}
      <div className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-xl border border-purple-500/20 shadow-lg">
        {/* Tabs */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setActiveTab("active")}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === "active"
                ? "bg-purple-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
          >
            Active Raffles
          </button>
          <button
            onClick={() => setActiveTab("history")}
            className={`px-4 py-2 rounded-lg font-medium transition-colors ${
              activeTab === "history"
                ? "bg-purple-600 text-white"
                : "bg-gray-700 text-gray-300 hover:bg-gray-600"
            }`}
          >
            History ({history.length})
          </button>
        </div>

        {activeTab === "active" ? (
          <>
            <div className="flex justify-between items-center mb-4">
              <p className="text-sm text-gray-400">
                Showing up to 50 most recent active raffles. Completed raffles are saved to History tab.
              </p>
              {wallet.publicKey && (
                <button
                  onClick={fetchRaffles}
                  disabled={loading}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {loading ? "Loading..." : "🔄 Refresh"}
                </button>
              )}
            </div>

            {!wallet.publicKey ? (
              <p className="text-gray-400 text-center py-8">Connect your wallet to view raffles</p>
            ) : loading ? (
              <p className="text-gray-400 text-center py-8">Loading raffles...</p>
            ) : raffles.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-400 mb-2">
                  Click the "🔄 Refresh" button above to load active raffles
                </p>
                <p className="text-sm text-gray-500">
                  Or create a new raffle to get started!
                </p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {raffles.map((raffle) => (
                  <div
                    key={raffle.address.toString()}
                    className="bg-gray-700/50 p-4 rounded-lg border border-gray-600"
                  >
                    <div className="space-y-2">
                      <div className="flex justify-between items-start">
                        <span className="text-sm font-semibold text-purple-400">
                          Raffle #{raffle.raffleId.toString()}
                        </span>
                        {raffle.state.completed && (
                          <span className="px-2 py-1 text-xs bg-green-600 rounded">
                            Completed
                          </span>
                        )}
                        {raffle.state.ended && (
                          <span className="px-2 py-1 text-xs bg-yellow-600 rounded">
                            Ended
                          </span>
                        )}
                        {raffle.state.active && (
                          <span className="px-2 py-1 text-xs bg-blue-600 rounded">
                            Active
                          </span>
                        )}
                      </div>

                      <div className="text-xs text-gray-400 break-all">
                        {raffle.address.toString()}
                      </div>

                      <div className="text-sm text-gray-300">
                        <p>Price: {(raffle.ticketPrice.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL</p>
                        <p>Tickets: {raffle.totalTicketsSold} / {raffle.maxTickets}</p>
                        <p>
                          End: {new Date(raffle.endTime.toNumber() * 1000).toLocaleDateString()}
                        </p>
                      </div>

                      {raffle.winner && (
                        <div className="mt-2 pt-2 border-t border-gray-600">
                          <p className="text-xs text-green-400">
                            Winner: {raffle.winner.toString().slice(0, 8)}...
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          /* History Tab */
          <div>
            {history.length === 0 ? (
              <p className="text-gray-400 text-center py-8">
                No completed raffles yet. Draw a winner to see it in history!
              </p>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {history.map((entry, index) => (
                  <div
                    key={index}
                    className="bg-gray-700/50 p-4 rounded-lg border border-green-600/30"
                  >
                    <div className="space-y-2">
                      <div className="flex justify-between items-start">
                        <span className="text-sm font-semibold text-purple-400">
                          Raffle #{entry.raffleId}
                        </span>
                        <span className="px-2 py-1 text-xs bg-green-600 rounded">
                          Completed
                        </span>
                      </div>

                      <div className="text-xs text-gray-400 break-all">
                        {entry.raffleAddress.slice(0, 16)}...
                      </div>

                      <div className="text-sm text-gray-300">
                        <p>Price: {entry.ticketPrice.toFixed(4)} SOL</p>
                        <p>Tickets Sold: {entry.totalTicketsSold} / {entry.maxTickets}</p>
                        <p>Ended: {new Date(entry.endTime * 1000).toLocaleDateString()}</p>
                      </div>

                      <div className="mt-2 pt-2 border-t border-green-600/30">
                        <p className="text-xs text-green-400 font-semibold">
                          🎉 Winner: Ticket #{entry.winningTicketNumber}
                        </p>
                        <p className="text-xs text-gray-400 break-all">
                          {entry.winner.slice(0, 16)}...
                        </p>
                        <p className="text-xs text-gray-500 mt-1">
                          Completed: {new Date(entry.completedAt).toLocaleString()}
                        </p>
                        <a
                          href={`https://explorer.solana.com/tx/${entry.transactionSignature}?cluster=devnet`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-purple-400 hover:text-purple-300 underline mt-1 inline-block"
                        >
                          View Transaction →
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
