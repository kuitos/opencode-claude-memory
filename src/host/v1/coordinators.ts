// V1 hook payloads → coordinator calls. The coordinators themselves are host-independent; these
// subclasses only translate V1 events and the V1 message list.
import { ExtractionCoordinator } from "../../extraction/ExtractionCoordinator.js"
import { RecallCoordinator } from "../../recall/RecallCoordinator.js"
import { deriveIgnoredFromHistory, detectIgnoreMemory, stripAutoMemoryParts } from "./ignore.js"
import { buildTurnID, collectSurfacedMemoryKeys, extractRecentTools, getLastUserQuery } from "./messages.js"
import type { ChatMessage, PluginEvent } from "./sdk.js"

export class V1RecallCoordinator extends RecallCoordinator {
  // `experimental.chat.messages.transform`: derive the turn state and start the selector prefetch.
  onMessagesTransform(output: { messages: ChatMessage[] }): void {
    const turn = getLastUserQuery(output.messages)
    const { sessionID } = turn
    if (!sessionID) {
      if (detectIgnoreMemory(turn.query)) output.messages = stripAutoMemoryParts(output.messages)
      return
    }
    const messages = output.messages
    const { ignored } = this.onTurn({
      sessionID,
      turnID: buildTurnID(sessionID, turn),
      query: turn.query,
      ignoredInHistory: () => deriveIgnoredFromHistory(messages),
      surfaced: () => collectSurfacedMemoryKeys(messages),
      recentTools: () => extractRecentTools(messages),
    })
    if (ignored) output.messages = stripAutoMemoryParts(output.messages)
  }

  onEvent(event: PluginEvent): void {
    if (event.type === "session.deleted") this.forget(event.properties.info.id)
  }
}

export class V1ExtractionCoordinator extends ExtractionCoordinator {
  onEvent(event: PluginEvent): void {
    if (event.type === "session.idle") this.onSessionIdle(event.properties.sessionID)
    else if (event.type === "session.deleted") this.onSessionDeleted(event.properties.info.id)
    else if (event.type === "session.status")
      this.onSessionStatus(event.properties.sessionID, event.properties.status.type)
  }
}
