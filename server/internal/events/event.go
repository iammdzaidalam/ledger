package events

import (
	"context"
	"encoding/json"
	"time"
)

const (
	SwarmCreated  = "swarm.created"
	TaskQueued    = "task.queued"
	TaskClaimed   = "task.claimed"
	HeartbeatLost = "task.heartbeat_lost"
	AttemptTurn   = "attempt.turn"
	AttemptDone   = "attempt.completed"
	GatePass      = "gate.pass"
	GateRetry     = "gate.retry"
	GateBlock     = "gate.block"
	GateFail      = "gate.fail"
	TaskMerging   = "task.merging"
	TaskMerged    = "task.merged"
	TaskConflict  = "task.conflict"
	SwarmDone     = "swarm.done"
	SwarmCanceled = "swarm.cancelled"
)

type Event struct {
	SwarmID   string         `json:"swarm_id"`
	TaskID    string         `json:"task_id"`
	AttemptID string         `json:"attempt_id"`
	Type      string         `json:"type"`
	Message   string         `json:"message"`
	Data      map[string]any `json:"data"`
	At        time.Time      `json:"at"`
}

func (e Event) JSON() []byte {
	if e.Data == nil {
		e.Data = map[string]any{}
	}
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	body, _ := json.Marshal(e)
	return body
}

type Publisher interface {
	Publish(ctx context.Context, e Event)
}

type Bus interface {
	Publisher
	Subscribe(swarmID string) (<-chan Event, func())
	Close()
}
