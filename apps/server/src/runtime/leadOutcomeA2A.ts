import type { A2AMessageType } from "@opc/shared";
import type { ContractMessageType } from "./contractMessage.js";

export interface LeadOutcomeA2AInput {
  task: string;
  deliveryAccepted: boolean;
  acceptedArtifactRefs: string[];
  acceptedFileCount: number;
  acceptanceStatus: string;
}

export interface LeadOutcomeA2ADecision {
  messageType: A2AMessageType;
  contractType: ContractMessageType;
  text: string;
  summary: string;
  artifactRefs?: string[];
  requiredArtifactHandoff: boolean;
}

export function decideLeadOutcomeA2A(input: LeadOutcomeA2AInput): LeadOutcomeA2ADecision {
  const task = input.task.slice(0, 80);
  const hasAcceptedArtifact = input.acceptedArtifactRefs.length > 0 || input.acceptedFileCount > 0;
  if (input.deliveryAccepted && hasAcceptedArtifact) {
    const summary = `Accepted deliverables are ready for task "${task}"`;
    return {
      messageType: "artifact_handoff",
      contractType: "handoff",
      text: `[artifact_handoff] ${summary}`,
      summary,
      artifactRefs: input.acceptedArtifactRefs.length ? input.acceptedArtifactRefs : undefined,
      requiredArtifactHandoff: true,
    };
  }
  const summary = `No accepted deliverable for task "${task}" (deliveryAcceptance=${input.acceptanceStatus})`;
  return {
    messageType: "dependency_blocked",
    contractType: "blocker",
    text: `[dependency_blocked] ${summary}`,
    summary,
    requiredArtifactHandoff: false,
  };
}
