package orch

import (
	"context"

	"connectrpc.com/connect"

	ledgerv1 "github.com/iammdzaidalam/ledger/server/gen/ledger/v1"
)

func (s *Service) StreamEvents(ctx context.Context, req *connect.Request[ledgerv1.StreamEventsRequest], stream *connect.ServerStream[ledgerv1.SwarmEvent]) error {
	if s.Bus == nil {
		return connect.NewError(connect.CodeUnavailable, errNoBus)
	}
	ch, release := s.Bus.Subscribe(req.Msg.SwarmId)
	defer release()
	for {
		select {
		case <-ctx.Done():
			return nil
		case e, open := <-ch:
			if !open {
				return nil
			}
			if err := stream.Send(eventProto(e)); err != nil {
				return err
			}
		}
	}
}
