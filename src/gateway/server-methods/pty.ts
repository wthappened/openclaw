import {
  assertGatewayPtyOwnership,
  createGatewayPtySession,
  destroyGatewayPtySession,
  listGatewayPtySessionsByOwner,
  resizeGatewayPtySession,
  writeGatewayPtySession,
} from "../pty-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function getPtyOwner(client: { connect?: { device?: { id?: string } }; connId?: string } | null): {
  ownerKey: string;
  connId: string;
  deviceId?: string;
} {
  const connId = client?.connId?.trim();
  if (!connId) {
    throw new Error("PTY requires an authenticated gateway connection");
  }
  const deviceId = client?.connect?.device?.id?.trim() || undefined;
  return {
    ownerKey: deviceId ? `device:${deviceId}` : `conn:${connId}`,
    connId,
    deviceId,
  };
}

function invalidParams(message: string) {
  return errorShape(ErrorCodes.INVALID_PARAMS, message);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const ptyHandlers: GatewayRequestHandlers = {
  "pty.create": async ({ client, params, respond, context }) => {
    try {
      const owner = getPtyOwner(client);
      const session = await createGatewayPtySession({
        owner,
        cols: asNumber(params.cols),
        rows: asNumber(params.rows),
        cwd: asString(params.cwd),
        shell: asString(params.shell),
        onOutput: ({ sessionId, data, connId }) => {
          context.broadcastToConnIds("pty.output", { sessionId, data }, new Set([connId]));
        },
        onExit: ({ sessionId, code, connId }) => {
          context.broadcastToConnIds("pty.exit", { sessionId, code }, new Set([connId]));
        },
      });
      respond(true, { sessionId: session.sessionId, cwd: session.cwd, shell: session.shell });
    } catch (error) {
      respond(false, undefined, invalidParams(error instanceof Error ? error.message : String(error)));
    }
  },
  "pty.write": ({ client, params, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessionId = asString(params.sessionId)?.trim();
      const data = asString(params.data);
      if (!sessionId) {
        respond(false, undefined, invalidParams("pty.write requires sessionId"));
        return;
      }
      if (typeof data !== "string") {
        respond(false, undefined, invalidParams("pty.write requires data"));
        return;
      }
      assertGatewayPtyOwnership({ sessionId, ownerKey: owner.ownerKey, connId: owner.connId });
      writeGatewayPtySession(sessionId, data);
      respond(true, { ok: true });
    } catch (error) {
      respond(false, undefined, invalidParams(error instanceof Error ? error.message : String(error)));
    }
  },
  "pty.resize": ({ client, params, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessionId = asString(params.sessionId)?.trim();
      if (!sessionId) {
        respond(false, undefined, invalidParams("pty.resize requires sessionId"));
        return;
      }
      assertGatewayPtyOwnership({ sessionId, ownerKey: owner.ownerKey, connId: owner.connId });
      resizeGatewayPtySession(sessionId, asNumber(params.cols), asNumber(params.rows));
      respond(true, { ok: true });
    } catch (error) {
      respond(false, undefined, invalidParams(error instanceof Error ? error.message : String(error)));
    }
  },
  "pty.kill": ({ client, params, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessionId = asString(params.sessionId)?.trim();
      if (!sessionId) {
        respond(false, undefined, invalidParams("pty.kill requires sessionId"));
        return;
      }
      assertGatewayPtyOwnership({ sessionId, ownerKey: owner.ownerKey, connId: owner.connId });
      destroyGatewayPtySession(sessionId);
      respond(true, { ok: true });
    } catch (error) {
      respond(false, undefined, invalidParams(error instanceof Error ? error.message : String(error)));
    }
  },
  "pty.list": ({ client, respond }) => {
    try {
      const owner = getPtyOwner(client);
      const sessions = listGatewayPtySessionsByOwner(owner.ownerKey).map((session) => {
        const current = assertGatewayPtyOwnership({
          sessionId: session.sessionId,
          ownerKey: owner.ownerKey,
          connId: owner.connId,
        });
        return {
          sessionId: current.sessionId,
          shell: current.shell,
          cwd: current.cwd,
          cols: current.cols,
          rows: current.rows,
          createdAt: current.createdAt,
        };
      });
      respond(true, { sessions });
    } catch (error) {
      respond(false, undefined, invalidParams(error instanceof Error ? error.message : String(error)));
    }
  },
};
