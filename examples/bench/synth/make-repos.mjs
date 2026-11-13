#!/usr/bin/env node
// Synthesize two small repositories with history for the Go and .NET bench
// examples: every feature commit adds source + tests, each repo has an
// external dependency (github.com/google/go-cmp; Humanizer.Core + xunit), so
// mining exercises the offline "prepare" step. Authors, dates and content are
// fixed, so commit shas are reproducible.
//
//   node make-repos.mjs <out-dir>              # <out-dir>/go-textkit, <out-dir>/dotnet-textkit
//   node make-repos.mjs <out-dir> --bundle     # also <out-dir>/<name>.bundle
//   node make-repos.mjs <out-dir> --prefix backend   # the project lives in backend/ (nested root)
//
// The vendored examples/bench/{go,dotnet}-textkit.bundle were made with
//   node synth/make-repos.mjs "$(mktemp -d)" --bundle  (then copied here).
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const GO_SUM = `github.com/google/go-cmp v0.6.0 h1:ofyhxvXcZhMsU5ulbFiLKl/XBFqE1GSq7atu8tAmTRI=
github.com/google/go-cmp v0.6.0/go.mod h1:17dUlkBOakJ0+DkrSSNjCkIjxS6bF9zb3elmeNGIjoY=
`;

/** @type {{ message: string, files: Record<string, string> }[]} */
const GO = [
  {
    message: 'Initial textkit: Reverse',
    files: {
      'go.mod': 'module example.com/textkit\n\ngo 1.22\n\nrequire github.com/google/go-cmp v0.6.0\n',
      'go.sum': GO_SUM,
      'README.md': '# textkit\n\nSmall string helpers.\n',
      'reverse.go': `// Package textkit has small string helpers.
package textkit

// Reverse returns s reversed.
func Reverse(s string) string {
	b := []byte(s)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}
`,
      'helpers_test.go': `package textkit

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func check(t *testing.T, want, got any) {
	t.Helper()
	if d := cmp.Diff(want, got); d != "" {
		t.Errorf("mismatch (-want +got):\\n%s", d)
	}
}
`,
      'reverse_test.go': `package textkit

import "testing"

func TestReverse(t *testing.T) {
	check(t, "olleh", Reverse("hello"))
	check(t, "", Reverse(""))
}
`,
    },
  },
  {
    message: 'Add Capitalize: upper-case the first letter of every word',
    files: {
      'capitalize.go': `package textkit

import "strings"

// Capitalize upper-cases the first letter of every word and joins words with one space.
func Capitalize(s string) string {
	words := strings.Fields(s)
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}
`,
      'capitalize_test.go': `package textkit

import "testing"

func TestCapitalize(t *testing.T) {
	check(t, "Hello Big World", Capitalize("hello  big world"))
	check(t, "", Capitalize("   "))
}
`,
    },
  },
  {
    message: 'Document the package in the README',
    files: { 'README.md': '# textkit\n\nSmall string helpers: Reverse, Capitalize, and more.\n' },
  },
  {
    message: 'Add WordCount: case-insensitive word frequencies',
    files: {
      'wordcount.go': `package textkit

import "strings"

// WordCount counts words case-insensitively.
func WordCount(s string) map[string]int {
	out := map[string]int{}
	for _, w := range strings.Fields(strings.ToLower(s)) {
		out[w]++
	}
	return out
}
`,
      'wordcount_test.go': `package textkit

import "testing"

func TestWordCount(t *testing.T) {
	check(t, map[string]int{"the": 2, "cat": 1, "hat": 1}, WordCount("The cat the HAT"))
	check(t, map[string]int{}, WordCount(""))
}
`,
    },
  },
  {
    message: 'Add Truncate: shorten to n runes with an ellipsis',
    files: {
      'truncate.go': `package textkit

// Truncate shortens s to at most n runes, ending in "…" when it was cut.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 0 {
		return ""
	}
	return string(r[:n-1]) + "…"
}
`,
      'truncate_test.go': `package textkit

import "testing"

func TestTruncate(t *testing.T) {
	check(t, "hello", Truncate("hello", 5))
	check(t, "hel…", Truncate("hello", 4))
	check(t, "hé…", Truncate("héllo", 3))
	check(t, "", Truncate("hello", 0))
}
`,
    },
  },
  {
    message:
      'Fix Reverse for multi-byte characters\n\nReverse swapped bytes, corrupting UTF-8 input such as "héllo". Reverse runes instead.',
    files: {
      'reverse.go': `// Package textkit has small string helpers.
package textkit

// Reverse returns s reversed (by rune, so UTF-8 input stays valid).
func Reverse(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}
`,
      'reverse_test.go': `package textkit

import "testing"

func TestReverse(t *testing.T) {
	check(t, "olleh", Reverse("hello"))
	check(t, "", Reverse(""))
	check(t, "olléh", Reverse("héllo"))
}
`,
    },
  },
];

const LIB = 'src/Textkit';
const TESTS = 'tests/Textkit.Tests';
const cs = (body) => `namespace Textkit;\n\npublic static partial class Text\n{\n${body}}\n`;
const csTest = (name, body) => `using Xunit;\n\nnamespace Textkit.Tests;\n\npublic class ${name}\n{\n${body}}\n`;

const DOTNET = [
  {
    message: 'Initial Textkit: Reverse',
    files: {
      'Textkit.slnx': `<Solution>\n  <Project Path="${LIB}/Textkit.csproj" />\n  <Project Path="${TESTS}/Textkit.Tests.csproj" />\n</Solution>\n`,
      'README.md': '# Textkit\n\nSmall string helpers.\n',
      [`${LIB}/Textkit.csproj`]: `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Humanizer.Core" Version="2.14.1" />
  </ItemGroup>
</Project>
`,
      [`${TESTS}/Textkit.Tests.csproj`]: `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../../${LIB}/Textkit.csproj" />
  </ItemGroup>
</Project>
`,
      [`${LIB}/Reverse.cs`]: cs(`    /// <summary>s reversed.</summary>
    public static string Reverse(string s)
    {
        var chars = s.ToCharArray();
        Array.Reverse(chars);
        return new string(chars);
    }
`),
      [`${TESTS}/ReverseTests.cs`]: csTest(
        'ReverseTests',
        `    [Fact]
    public void ReversesAscii() => Assert.Equal("olleh", Text.Reverse("hello"));

    [Fact]
    public void ReversesEmpty() => Assert.Equal("", Text.Reverse(""));
`,
      ),
    },
  },
  {
    message: 'Add Titleize: humanize identifiers into title case',
    files: {
      [`${LIB}/Titleize.cs`]: `using Humanizer;

${cs(`    /// <summary>"some_identifier" -> "Some Identifier".</summary>
    public static string Titleize(string s) => s.Humanize(LetterCasing.Title);
`)}`,
      [`${TESTS}/TitleizeTests.cs`]: csTest(
        'TitleizeTests',
        `    [Theory]
    [InlineData("hello_world", "Hello World")]
    [InlineData("SomePascalCase", "Some Pascal Case")]
    public void Titleizes(string input, string expected) => Assert.Equal(expected, Text.Titleize(input));
`,
      ),
    },
  },
  {
    message: 'Document the package in the README',
    files: { 'README.md': '# Textkit\n\nSmall string helpers: Reverse, Titleize, and more.\n' },
  },
  {
    message: 'Add WordCount: case-insensitive word frequencies',
    files: {
      [`${LIB}/WordCount.cs`]: cs(`    /// <summary>Case-insensitive word frequencies.</summary>
    public static Dictionary<string, int> WordCount(string s)
    {
        var counts = new Dictionary<string, int>();
        foreach (var w in s.ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            counts[w] = counts.GetValueOrDefault(w) + 1;
        return counts;
    }
`),
      [`${TESTS}/WordCountTests.cs`]: csTest(
        'WordCountTests',
        `    [Fact]
    public void CountsCaseInsensitively()
    {
        var counts = Text.WordCount("The cat the HAT");
        Assert.Equal(2, counts["the"]);
        Assert.Equal(1, counts["hat"]);
        Assert.Equal(3, counts.Count);
    }

    [Fact]
    public void EmptyHasNoWords() => Assert.Empty(Text.WordCount("  "));
`,
      ),
    },
  },
  {
    message: 'Add Truncate: shorten with an ellipsis',
    files: {
      [`${LIB}/Truncate.cs`]: cs(`    /// <summary>At most n characters, ending in "…" when cut.</summary>
    public static string Truncate(string s, int n)
    {
        if (s.Length <= n) return s;
        if (n <= 0) return "";
        return s[..(n - 1)] + "…";
    }
`),
      [`${TESTS}/TruncateTests.cs`]: csTest(
        'TruncateTests',
        `    [Theory]
    [InlineData("hello", 5, "hello")]
    [InlineData("hello", 4, "hel…")]
    [InlineData("hello", 0, "")]
    public void Truncates(string input, int n, string expected) => Assert.Equal(expected, Text.Truncate(input, n));
`,
      ),
    },
  },
  {
    message:
      'Fix Reverse for surrogate pairs\n\nReverse swapped UTF-16 code units, breaking emoji such as "a😀b". Reverse text elements instead.',
    files: {
      [`${LIB}/Reverse.cs`]: `using System.Globalization;

${cs(`    /// <summary>s reversed by text element (surrogate pairs and combining marks stay intact).</summary>
    public static string Reverse(string s)
    {
        var elements = new List<string>();
        var e = StringInfo.GetTextElementEnumerator(s);
        while (e.MoveNext()) elements.Add(e.GetTextElement());
        elements.Reverse();
        return string.Concat(elements);
    }
`)}`,
      [`${TESTS}/ReverseTests.cs`]: csTest(
        'ReverseTests',
        `    [Fact]
    public void ReversesAscii() => Assert.Equal("olleh", Text.Reverse("hello"));

    [Fact]
    public void ReversesEmpty() => Assert.Equal("", Text.Reverse(""));

    [Fact]
    public void KeepsSurrogatePairs() => Assert.Equal("b😀a", Text.Reverse("a😀b"));
`,
      ),
    },
  },
];

function build(dir, commits, prefix = '') {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Textkit Dev',
    GIT_AUTHOR_EMAIL: 'dev@textkit.example',
    GIT_COMMITTER_NAME: 'Textkit Dev',
    GIT_COMMITTER_EMAIL: 'dev@textkit.example',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' }).toString().trim();
  git('init', '-q', '-b', 'main');
  commits.forEach((c, i) => {
    for (const [f, text] of Object.entries(c.files)) {
      mkdirSync(dirname(join(dir, prefix, f)), { recursive: true });
      writeFileSync(join(dir, prefix, f), text);
    }
    git('add', '-A');
    const date = `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`;
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', c.message], {
      cwd: dir,
      env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: 'pipe',
    });
  });
  return git('rev-parse', 'HEAD');
}

const [outArg, ...flags] = process.argv.slice(2);
if (!outArg) {
  process.stderr.write('usage: make-repos.mjs <out-dir> [--bundle] [--prefix <dir>]\n');
  process.exit(2);
}
const out = resolve(outArg);
const prefix = flags.includes('--prefix') ? flags[flags.indexOf('--prefix') + 1] : '';
for (const [name, commits] of [
  ['go-textkit', GO],
  ['dotnet-textkit', DOTNET],
]) {
  const dir = join(out, name);
  const head = build(dir, commits, prefix);
  if (flags.includes('--bundle'))
    execFileSync('git', ['bundle', 'create', '--quiet', join(out, `${name}.bundle`), 'main'], {
      cwd: dir,
      stdio: 'pipe',
    });
  process.stdout.write(`${name} ${head}\n`);
}
