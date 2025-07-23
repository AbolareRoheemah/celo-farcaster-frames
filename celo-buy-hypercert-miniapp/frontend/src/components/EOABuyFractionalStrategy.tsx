import { Currency, Taker } from "@hypercerts-org/marketplace-sdk";
import { zeroAddress } from "viem";
import { waitForTransactionReceipt, signMessage } from "viem/actions";

import { SUPPORTED_CHAINS } from "../lib/constants";
import { decodeContractError } from "../lib/decodeContractError";
import { getReferralTag, submitReferral } from '@divvi/referral-sdk';

import { BuyFractionalStrategy } from "../lib/BuyFractionalStrategy";
import { MarketplaceOrder } from "../lib/types";
import { getCurrencyByAddress } from "../lib/hypercerts-utils";
import { ExtraContent } from "./extra-content";
import { useStore } from "../lib/account-store";

const calculateBigIntPercentage = (
  numerator: bigint | string | null | undefined,
  denominator: bigint | string | null | undefined,
) => {
  if (!numerator || !denominator) {
    return undefined;
  }
  const numeratorBigInt = BigInt(numerator);
  const denominatorBigInt = BigInt(denominator);
  const precision = 10 ** 18;
  const unCorrected = Number(
    (numeratorBigInt * BigInt(100) * BigInt(precision)) / denominatorBigInt,
  );
  return unCorrected / precision;
};

const isFarcasterEnvironment = () => {
  if (typeof window === 'undefined') return false;
  
  const userAgent = navigator.userAgent.toLowerCase();
  const isFarcasterApp = userAgent.includes('farcaster') || 
                        window.location.hostname.includes('warpcast') ||
                        window.parent !== window; // Often true in frames
  
  console.log('Environment detection:', {
    userAgent,
    hostname: window.location.hostname,
    isFrame: window.parent !== window,
    isFarcasterApp
  });
  
  return isFarcasterApp;
};

export class EOABuyFractionalStrategy extends BuyFractionalStrategy {
  async execute({
    order,
    unitAmount,
    pricePerUnit,
    hypercertName,
    totalUnitsInHypercert,
  }: {
    order: MarketplaceOrder;
    unitAmount: bigint;
    pricePerUnit: string;
    hypercertName?: string | null;
    totalUnitsInHypercert?: bigint;
  }) {
    const {
      setDialogStep: setStep,
      setSteps,
      setOpen,
      setExtraContent,
    } = this.dialogContext;
    
    if (!this.exchangeClient) {
      this.dialogContext.setOpen(false);
      throw new Error("No client");
    }

    if (!this.chainId) {
      this.dialogContext.setOpen(false);
      throw new Error("No chain id");
    }

    if (!this.walletClient.data) {
      this.dialogContext.setOpen(false);
      throw new Error("No wallet client data");
    }

    const isInFarcaster = isFarcasterEnvironment();
    console.log('Detected Farcaster environment:', isInFarcaster);

    setSteps([
      {
        id: "Setting up order execution",
        description: "Setting up order execution",
      },
      {
        id: "ERC20",
        description: "Setting approval",
      },
      {
        id: "Transfer manager",
        description: "Approving transfer manager",
      },
      {
        id: "Divvi referral setup",
        description: "Setting up referral attribution",
      },
      {
        id: "Awaiting buy signature",
        description: "Awaiting buy signature",
      },
      {
        id: "Awaiting confirmation",
        description: "Awaiting confirmation",
      },
    ]);
    setOpen(true);

    let currency: Currency | undefined;
    let takerOrder: Taker;
    
    try {
      await setStep("Setting up order execution");
      currency = getCurrencyByAddress(order.chainId, order.currency);

      if (!currency) {
        throw new Error(
          `Invalid currency ${order.currency} on chain ${order.chainId}`,
        );
      }

      takerOrder = this.exchangeClient.createFractionalSaleTakerBid(
        order,
        this.address,
        unitAmount.toString(),
        pricePerUnit,
      );
    } catch (e) {
      await setStep(
        "Setting up order execution",
        "error",
        e instanceof Error ? e.message : "Error setting up order execution",
      );
      console.error(e);
      throw new Error("Error setting up order execution");
    }

    if (!currency) {
      throw new Error(
        `Invalid currency ${order.currency} on chain ${order.chainId}`,
      );
    }

    const totalPrice = BigInt(order.price) * unitAmount;
    
    // ERC20 Approval
    try {
      await setStep("ERC20");
      if (currency.address !== zeroAddress) {
        console.log("Handling ERC20 approval for currency:", currency.address);
        
        if (isInFarcaster) {
          // In Farcaster, skip allowance check and directly attempt approval
          console.log("Farcaster detected: Skipping allowance check, attempting direct approval");
          
          try {
            // Always attempt approval in Farcaster since we can't check allowance
            const approveTx = await this.exchangeClient.approveErc20(
              order.currency,
              totalPrice,
              {
                gasLimit: BigInt(100000), // Explicit gas for Farcaster
              }
            );

            console.log("Approval transaction sent:", approveTx.hash);
            
            const receipt = await waitForTransactionReceipt(this.walletClient.data, {
              hash: approveTx.hash as `0x${string}`,
              timeout: 120000,
              pollingInterval: 2000,
            });
            
            console.log("Approval confirmed:", receipt.status);
            
            if (receipt.status !== 'success') {
              throw new Error("Approval transaction failed");
            }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (approvalError: any) {
            // If approval fails, it might be because we already have sufficient allowance
            // In Farcaster, we can't check, so we'll proceed and let the main transaction fail if needed
            console.log("Approval failed, might already have sufficient allowance:", approvalError.message);
            
            // Only throw if it's not an allowance-related error
            if (!approvalError.message.includes('allowance') && 
                !approvalError.message.includes('approved') &&
                !approvalError.message.includes('insufficient')) {
              throw approvalError;
            }
          }
        } else {
          // Regular web environment - use normal allowance check
          console.log("Regular web environment: Checking allowance");
          
          const currentAllowance = await this.getERC20Allowance(
            order.currency as `0x${string}`,
          );

          console.log("Current allowance:", currentAllowance.toString());
          console.log("Required amount:", totalPrice.toString());

          if (currentAllowance < totalPrice) {
            console.log("Approval needed, requesting approval...");
            
            const approveTx = await this.exchangeClient.approveErc20(
              order.currency,
              totalPrice,
            );

            console.log("Approval transaction sent:", approveTx.hash);
            
            const receipt = await waitForTransactionReceipt(this.walletClient.data, {
              hash: approveTx.hash as `0x${string}`,
              timeout: 60000,
            });
            
            if (receipt.status !== 'success') {
              throw new Error("Approval transaction failed");
            }
          } else {
            console.log("Sufficient allowance already exists");
          }
        }
      }
    } catch (e) {
      console.error("ERC20 approval error details:", e);

      let errorMessage = "Approval error";
      // Type guard for Error
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.message.includes("insufficient funds")) {
        errorMessage = "Insufficient funds for approval. Please ensure you have enough ETH for gas fees.";
      } else if (err.message.includes("user rejected") || err.message.includes("User rejected")) {
        errorMessage = "Approval transaction was rejected. Please try again and confirm the transaction.";
      } else if (err.message.includes("does not support")) {
        errorMessage = "Wallet compatibility issue. Please try opening this page in a regular browser.";
      } else {
        errorMessage = `Approval failed: ${err.message}`;
      }

      await setStep("ERC20", "error", errorMessage);
      throw new Error(errorMessage);
    }


    // Transfer Manager Approval
    try {
      await setStep("Transfer manager");

      if (isInFarcaster) {
        // In Farcaster, skip the check and directly attempt approval
        console.log("Farcaster detected: Attempting direct transfer manager approval");

        try {
          const transferManagerApprove = await this.exchangeClient
            .grantTransferManagerApproval()
            .call();

          console.log("Transfer manager approval sent:", transferManagerApprove.hash);

          const receipt = await waitForTransactionReceipt(this.walletClient.data, {
            hash: transferManagerApprove.hash as `0x${string}`,
            timeout: 120000,
          });

          if (receipt.status !== 'success') {
            throw new Error("Transfer manager approval failed");
          }
        } catch (transferError) {
          // Similar to ERC20, might already be approved
          const err =
            transferError instanceof Error
              ? transferError
              : new Error(String(transferError));
          console.log(
            "Transfer manager approval failed, might already be approved:",
            err.message,
          );

          if (
            !err.message.includes('approved') &&
            !err.message.includes('already')
          ) {
            throw err;
          }
        }
      } else {
        // Regular web environment
        const isTransferManagerApproved =
          await this.exchangeClient.isTransferManagerApproved();

        console.log("Transfer manager approved:", isTransferManagerApproved);

        if (!isTransferManagerApproved) {
          console.log("Transfer manager approval needed...");

          const transferManagerApprove = await this.exchangeClient
            .grantTransferManagerApproval()
            .call();

          console.log("Transfer manager approval sent:", transferManagerApprove.hash);

          const receipt = await waitForTransactionReceipt(this.walletClient.data, {
            hash: transferManagerApprove.hash as `0x${string}`,
            timeout: 60000,
          });

          if (receipt.status !== 'success') {
            throw new Error("Transfer manager approval failed");
          }
        }
      }
    } catch (e) {
      console.error("Transfer manager approval error:", e);

      let errorMessage = "Error approving transfer manager";
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.message.includes("user rejected")) {
        errorMessage =
          "Transfer manager approval was rejected. This is required to complete the purchase.";
      } else if (err.message.includes("does not support")) {
        errorMessage =
          "Wallet compatibility issue with transfer manager. Please try in a regular browser.";
      } else {
        errorMessage = `Transfer manager approval failed: ${err.message}`;
      }

      await setStep("Transfer manager", "error", errorMessage);
      throw new Error(errorMessage);
    }

    // ✅ Divvi Off-Chain Referral Setup (Before Transaction)
    let referralTag = '';
    let signedMessage = '';
    let referralSignature = '';
    
    try {
      await setStep("Divvi referral setup");
      
      // Generate referral tag
      referralTag = getReferralTag({
        user: this.address,
        consumer: '0x21dfd1CfD1d45801f46B0F40Aed056b064045aA2', // Your actual consumer address
      });
      
      // Create and sign referral message
      const referralMessage = `Divvi Referral Attribution\nReferral Tag: ${referralTag}\nOrder ID: ${order.id || 'unknown'}\nTimestamp: ${Date.now()}`;
      
      referralSignature = await signMessage(this.walletClient.data, { 
        message: referralMessage 
      });
      
      signedMessage = referralMessage;
      
    } catch (e) {
      await setStep(
        "Divvi referral setup",
        "error",
        e instanceof Error ? e.message : "Error setting up referral",
      );
      console.error('Divvi referral setup failed:', e);
      // Don't throw - continue with transaction even if referral setup fails
    }

    // Execute Transaction (No modifications needed to your existing SDK calls!)
    try {
      await setStep("Awaiting buy signature");
      
      const overrides = currency.address === zeroAddress ? { value: totalPrice } : undefined;
      
      // ✅ Use your existing SDK exactly as before - no changes needed!
      const { call } = this.exchangeClient.executeOrder(
        order,
        takerOrder,
        order.signature,
        undefined,
        overrides, // No referral modifications needed here!
      );
      
      const tx = await call();
      
      await setStep("Awaiting confirmation");
      const receipt = await waitForTransactionReceipt(this.walletClient.data, {
        hash: tx.hash as `0x${string}`,
      });
      
      // ✅ Submit Divvi Referral (After Transaction Success)
      try {
        if (signedMessage && referralSignature) {
          await submitReferral({
            message: signedMessage,
            signature: referralSignature as `0x${string}`,
            chainId: this.chainId,
          });
          console.log('Divvi referral submitted successfully');
        }
      } catch (err) {
        console.error('Divvi referral submission failed (non-critical):', err);
        // Don't throw - transaction already succeeded
      }
      
      useStore.getState().emitHash(receipt.transactionHash);
      const chain = SUPPORTED_CHAINS.find((x) => x.id === order.chainId);
      await setStep("Awaiting confirmation", "completed");
      
      const message =
        hypercertName && totalUnitsInHypercert !== undefined ? (
          <span>
            Congratulations, you successfully bought{" "}
            <b>
              {calculateBigIntPercentage(unitAmount, totalUnitsInHypercert)}%
            </b>{" "}
            of <b>{hypercertName}</b>.
          </span>
        ) : (
          "Your transaction was successful"
        );

      setExtraContent(() => (
        <ExtraContent
          message={message}
          hypercertId={order.hypercert_id}
          onClose={() => setOpen(false)}
          chain={chain!}
          receipt={receipt}
        />
      ));
      
    } catch (e) {
      const decodedMessage = decodeContractError(e, "Error buying listing");
      await setStep("Awaiting confirmation", "error", decodedMessage);
      console.error(e);
      
      // Emit error to store so UI can handle it
      useStore.getState().emitError(e);
      
      throw new Error(decodedMessage);
    }
  }
}