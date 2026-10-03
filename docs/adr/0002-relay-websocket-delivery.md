# Relay events over WebSocket, not webhooks

The agent receives Relay events through `relay.websocket.run` instead of a webhook endpoint, because it runs from a laptop with no public HTTPS URL and Relay's docs name WebSocket as the path for an always-on backend. Each event is committed to SQLite by `event_id` before the SDK acknowledges it, and work happens from that inbox (Relay-SDK `cookbook/websocket-agent`). The agent must have zero webhook subscriptions, so switching back means deleting nothing silently: re-create a subscription and add a signed webhook route.
