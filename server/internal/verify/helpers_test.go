package verify_test

import "errors"

func errorsIs(err, target error) bool { return errors.Is(err, target) }

func errorsAs[T any](err error, target *T) bool { return errors.As(err, target) }
