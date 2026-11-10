package events

import (
	"context"
	"log/slog"
)

func Open(ctx context.Context, redisURL string, log *slog.Logger, onDrop func()) Bus {
	hub := NewHub(DefaultBuffer)
	hub.OnDrop = onDrop
	if redisURL == "" {
		return hub
	}
	bus, err := NewRedis(ctx, redisURL, hub, log)
	if err != nil {
		log.Warn("redis unavailable, using in-memory events", "err", err)
		return hub
	}
	log.Info("events over redis", "channel", Channel)
	return bus
}
