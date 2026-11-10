package orch

import (
	"encoding/json"
	"strings"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
	"github.com/iammdzaidalam/ledger/server/internal/events"
	"github.com/iammdzaidalam/ledger/server/internal/store"
)

func taskState(s string) ledgerv1.TaskState {
	return ledgerv1.TaskState(ledgerv1.TaskState_value["TASK_STATE_"+strings.ToUpper(s)])
}

func swarmState(s string) ledgerv1.SwarmState {
	return ledgerv1.SwarmState(ledgerv1.SwarmState_value["SWARM_STATE_"+strings.ToUpper(s)])
}

func decision(s string) ledgerv1.GateDecision {
	return ledgerv1.GateDecision(ledgerv1.GateDecision_value["GATE_DECISION_"+strings.ToUpper(s)])
}

func stamp(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

func counts(raw []byte) map[string]int32 {
	out := map[string]int32{}
	for _, state := range store.TaskStates {
		out[state] = 0
	}
	var got map[string]int32
	if json.Unmarshal(raw, &got) == nil {
		for k, v := range got {
			out[k] = v
		}
	}
	return out
}

func eventProto(e events.Event) *ledgerv1.SwarmEvent {
	data := e.Data
	if data == nil {
		data = map[string]any{}
	}
	body, _ := json.Marshal(data)
	return &ledgerv1.SwarmEvent{
		SwarmId: e.SwarmID, TaskId: e.TaskID, AttemptId: e.AttemptID, Type: e.Type,
		Message: e.Message, DataJson: string(body), At: timestamppb.New(e.At),
	}
}
