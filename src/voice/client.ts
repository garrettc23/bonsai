/**
 * ElevenLabs Conversational AI client.
 *
 * Three calls we care about:
 *   1. POST /v1/convai/agents          — create an agent with our config
 *   2. POST /v1/convai/agents/:id/link — attach a Twilio trunk phone number
 *   3. POST /v1/convai/twilio/outbound-call — initiate an outbound call
 *
 * All three are wrapped here. If ELEVENLABS_API_KEY is unset, construction
 * throws. The orchestrator checks env and falls back to the simulator.
 *
 * Note: ElevenLabs' API surface is evolving. These endpoints are based on
 * the public docs as of 2026-04. If they've changed, update URLs here only.
 */
import type { ElevenLabsAgentConfig } from "./agent-config.ts";

const BASE_URL = "https://api.elevenlabs.io";

export interface CreateAgentResponse {
  agent_id: string;
}

export interface OutboundCallResponse {
  call_sid: string;
  conversation_id: string;
}

export class ElevenLabsClient {
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!key) throw new Error("ElevenLabsClient: ELEVENLABS_API_KEY not set");
    this.apiKey = key;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json",
      ...(extra ?? {}),
    };
  }

  async createAgent(config: ElevenLabsAgentConfig): Promise<CreateAgentResponse> {
    const res = await fetch(`${BASE_URL}/v1/convai/agents`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`createAgent failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as CreateAgentResponse;
  }

  /**
   * Initiate an outbound call via a pre-configured Twilio trunk.
   * Requires that the ElevenLabs workspace has Twilio credentials linked
   * in the dashboard (ELEVENLABS_TWILIO_PHONE_NUMBER_ID is the ID of the
   * linked number).
   */
  async startOutboundCall(opts: {
    agent_id: string;
    phone_number_id: string; // the ElevenLabs-side ID of the linked Twilio number
    to_number: string;
  }): Promise<OutboundCallResponse> {
    const res = await fetch(`${BASE_URL}/v1/convai/twilio/outbound-call`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        agent_id: opts.agent_id,
        agent_phone_number_id: opts.phone_number_id,
        to_number: opts.to_number,
      }),
    });
    if (!res.ok) throw new Error(`startOutboundCall failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as OutboundCallResponse;
  }

  async getConversation(conversation_id: string): Promise<unknown> {
    const res = await fetch(`${BASE_URL}/v1/convai/conversations/${conversation_id}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`getConversation failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
