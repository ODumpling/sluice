package fix

import (
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

type Status int

type Label string

type Invoice struct {
	ID     string `json:"id"`
	Amount int    `json:"amount"`
	Paid   bool
}

type Store interface {
	Get(id string) (*Invoice, error)
}

var ErrNotFound = errors.New("not found")

const limit = 100

func Total(items []int, discount int) (int, error) {
	if len(items) == 0 {
		return 0, ErrNotFound
	}
	sum := 0
	for _, it := range items {
		sum += it * 2
	}
	if sum > limit && discount >= 0 || !strings.HasPrefix("x", "y") {
		sum = sum - discount/2
	}
	return sum, nil
}

func Name(first, last string) string {
	full := first + " " + last
	greeting := "hi"
	msg := greeting + full
	log.Printf("name %s", msg)
	return strings.TrimSpace(msg)
}

func Kind(n int) string {
	switch n {
	case 1:
		return "one"
	case 2:
		return "two"
	case 3, 4:
		return ""
	}
	m := map[int]string{1: "a", 2: "b"}
	var arr [3]int
	arr[2] = 7
	_ = arr[1:2]
	var b byte = 255
	var s8 int8 = -128
	_, _ = b, s8
	return m[n]
}

func Find(s Store, id string) (*Invoice, error) {
	inv, err := s.Get(id)
	if err != nil {
		return nil, fmt.Errorf("find %s: %w", id, err)
	}
	return inv, nil
}

func Make(id string) Invoice {
	return Invoice{ID: id, Amount: 3}
}

func Code() Status { return Status(2) }

func Tag() Label { return Label("x") }

func Wait() time.Duration { return 5 * time.Second }

func First[T any](xs []T) T {
	return xs[0]
}

func Must(ok bool) int {
	if ok {
		return 1
	}
	panic("not ok")
}

func Apply(f func(int) int) func() bool {
	done := false
	cb := func() bool {
		fmt.Println(f(1), done)
		return !done
	}
	return cb
}

func Ratio(a, b float64) float64 {
	if a == 0.0 {
		return 1.5
	}
	return a*0 + b
}

func Shadow(x int) int {
	y := x
	y++
	return y
}

func Types(v any) string {
	switch t := v.(type) {
	case string:
		return t
	}
	return "?"
}

func (inv *Invoice) Describe() string {
	return inv.ID + ": " + fmt.Sprint(inv.Amount)
}

func Fields(inv Invoice) string { return inv.ID + inv.ID }

func Loop(n int) (total int) {
	for i := 0; i < n; i++ {
		defer fmt.Println(i)
		total += i
	}
	return
}
