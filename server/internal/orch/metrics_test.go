package orch_test

import (
	"sort"
	"strings"
	"testing"
)

func gather(t *testing.T, r *rig) map[string]float64 {
	t.Helper()
	families, err := r.metrics.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]float64{}
	for _, f := range families {
		for _, m := range f.GetMetric() {
			var labels []string
			for _, l := range m.GetLabel() {
				labels = append(labels, l.GetName()+`="`+l.GetValue()+`"`)
			}
			sort.Strings(labels)
			name := f.GetName()
			if len(labels) > 0 {
				name += "{" + strings.Join(labels, ",") + "}"
			}
			switch {
			case m.Counter != nil:
				out[name] = m.Counter.GetValue()
			case m.Gauge != nil:
				out[name] = m.Gauge.GetValue()
			case m.Histogram != nil:
				out[name] = float64(m.Histogram.GetSampleCount())
			}
		}
	}
	return out
}
