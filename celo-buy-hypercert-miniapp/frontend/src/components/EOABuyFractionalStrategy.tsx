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
        const currentAllowance = await this.getERC20Allowance(
          order.currency as `0x${string}`,
        );

        if (currentAllowance < totalPrice) {
          const approveTx = await this.exchangeClient.approveErc20(
            order.currency,
            totalPrice,
          );
          await waitForTransactionReceipt(this.walletClient.data, {
            hash: approveTx.hash as `0x${string}`,
          });
        }
      }
    } catch (e) {
      await setStep(
        "ERC20",
        "error",
        e instanceof Error ? e.message : "Approval error",
      );
      console.error(e);
      throw new Error("Approval error");
    }

    // Transfer Manager Approval
    try {
      await setStep("Transfer manager");
      const isTransferManagerApproved =
        await this.exchangeClient.isTransferManagerApproved();
      if (!isTransferManagerApproved) {
        const transferManagerApprove = await this.exchangeClient
          .grantTransferManagerApproval()
          .call();
        await waitForTransactionReceipt(this.walletClient.data, {
          hash: transferManagerApprove.hash as `0x${string}`,
        });
      }
    } catch (e) {
      await setStep(
        "Transfer manager",
        "error",
        e instanceof Error ? e.message : "Error approving transfer manager",
      );
      console.error(e);
      throw new Error("Approval error");
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
      
      useStore.getState().emitHash(receipt);
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
      throw new Error(decodedMessage);
    }
  }
}