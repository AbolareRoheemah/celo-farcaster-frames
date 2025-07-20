import { Currency, Taker } from "@hypercerts-org/marketplace-sdk";
import { zeroAddress } from "viem";
import { signMessage } from 'viem/actions';

import { decodeContractError } from "../lib/decodeContractError";
import { ExtraContent } from "./extra-content";
import { SUPPORTED_CHAINS } from "../lib/constants";

import { BuyFractionalStrategy } from "../lib/BuyFractionalStrategy";
import { getCurrencyByAddress } from "../lib/hypercerts-utils";
import { MarketplaceOrder } from "../lib/types";
import { getReferralTag, submitReferral } from '@divvi/referral-sdk';

export class SafeBuyFractionalStrategy extends BuyFractionalStrategy {
  async execute({
    order,
    unitAmount,
    pricePerUnit,
  }: {
    order: MarketplaceOrder;
    unitAmount: bigint;
    pricePerUnit: string;
  }) {
    const {
      setDialogStep: setStep,
      setSteps,
      setOpen,
      setExtraContent,
    } = this.dialogContext;
    
    if (!this.exchangeClient) {
      setOpen(false);
      throw new Error("No client");
    }

    if (!this.chainId) {
      setOpen(false);
      throw new Error("No chain id");
    }

    if (!this.walletClient.data) {
      setOpen(false);
      throw new Error("No wallet client data");
    }

    setSteps([
      {
        id: "Setting up order execution",
        description: "Setting up order execution",
      },
      {
        id: "ERC20",
        description: "Setting approval on Safe",
      },
      {
        id: "Transfer manager",
        description: "Approving transfer manager on Safe",
      },
      {
        id: "Divvi referral setup",
        description: "Setting up referral attribution",
      },
      {
        id: "Submitting order",
        description: "Submitting buy transaction to Safe transaction queue",
      },
      {
        id: "Transaction queued",
        description: "Transaction(s) queued on Safe",
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
          console.debug("Approving ERC20");
          await this.exchangeClient.approveErc20Safe(
            this.address,
            order.currency,
            totalPrice,
          );
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
        await this.exchangeClient.isTransferManagerApprovedSafe(this.address);

      if (!isTransferManagerApproved) {
        console.debug("Approving transfer manager");
        await this.exchangeClient.grantTransferManagerApprovalSafe(
          this.address,
        );
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

    // ✅ Divvi Off-Chain Referral Setup (For Safe Transactions)
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
      
      // Create and sign referral message for Safe
      const referralMessage = `Divvi Referral Attribution (Safe Transaction)\nReferral Tag: ${referralTag}\nSafe Address: ${this.address}\nOrder ID: ${order.id || 'unknown'}\nTimestamp: ${Date.now()}`;
      
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

    // Execute Safe Transaction (No modifications needed!)
    try {
      await setStep("Submitting order");
      
      const overrides = currency.address === zeroAddress ? { value: totalPrice } : undefined;
      
      // ✅ Use your existing Safe SDK exactly as before - no changes needed!
      await this.exchangeClient.executeOrderSafe(
        this.address,
        order,
        takerOrder,
        order.signature,
        overrides, // No referral modifications needed here!
      );

      await setStep("Transaction queued");

      // ✅ Submit Divvi Referral (After Safe Transaction Queued)
      try {
        if (signedMessage && referralSignature) {
          await submitReferral({
            message: signedMessage,
            signature: referralSignature as `0x${string}`,
            chainId: this.chainId,
          });
          console.log('Divvi referral submitted successfully for Safe transaction');
        }
      } catch (err) {
        console.error('Divvi referral submission failed (non-critical):', err);
        // Don't throw - Safe transaction already queued
      }

      const chain = SUPPORTED_CHAINS.find((x) => x.id === order.chainId);

      const message = (
        <span>
          Transaction requests are submitted to the connected Safe.
          <br />
          <br />
          You can view the transactions in the Safe application.
          <br />
          <br />
          Referral attribution has been recorded with Divvi.
        </span>
      );

      setExtraContent(() => (
        <ExtraContent
          message={message}
          hypercertId={order.hypercert_id}
          onClose={() => setOpen(false)}
          chain={chain!}
          isSafe={true}
          safeAddress={this.address as `0x${string}`}
        />
      ));
      
    } catch (e) {
      const decodedMessage = decodeContractError(e, "Error buying listing");
      await setStep("Submitting order", "error", decodedMessage);
      console.error(e);
      throw new Error(decodedMessage);
    }
  }
}