import { describe, expect, test } from "bun:test"
import { previewBlocks, renderMarkdown } from "../src/app/markdown"

describe("markdown rendering fixes", () => {
  test("does not inject emphasis or strikethrough tags inside link href attributes", () => {
    const html = renderMarkdown("[spec](https://example.com/a__b__c/~~old~~)")
    expect(html).toContain('href="https://example.com/a__b__c/~~old~~"')
    expect(html).not.toContain("<a href=\"https://example.com/a<strong>")
    expect(html).not.toContain("<del>")

    const bare = renderMarkdown("See https://example.com/a__b__c/path.")
    expect(bare).toContain('href="https://example.com/a__b__c/path"')
    expect(bare).toContain(">https://example.com/a__b__c/path</a>.")
  })

  test("handles balanced parentheses, quotes around URLs, and formatted link labels", () => {
    const wiki = renderMarkdown("See https://en.wikipedia.org/wiki/Markdown_(markup_language) now")
    expect(wiki).toContain('href="https://en.wikipedia.org/wiki/Markdown_(markup_language)"')
    expect(wiki).not.toContain("<em>")

    const quoted = renderMarkdown('Visit "https://example.com/docs."')
    expect(quoted).toContain('&quot;<a href="https://example.com/docs"')
    expect(quoted).toContain("</a>.&quot;")

    const angled = renderMarkdown("<https://example.com/angle>")
    expect(angled).toContain('&lt;<a href="https://example.com/angle"')
    expect(angled).toContain("</a>&gt;")

    const boldCodeLink = renderMarkdown("[**`api`**](https://example.com/v1)")
    expect(boldCodeLink).toContain('href="https://example.com/v1"')
    expect(boldCodeLink).toContain("<strong><code>api</code></strong>")

    const nestedBare = renderMarkdown("[See https://other.test](https://primary.test)")
    expect(nestedBare.match(/<a /g)?.length).toBe(1)
    expect(nestedBare).toContain('href="https://primary.test"')
  })

  test("strips raw NUL bytes so literal \\0N\\0 text cannot collide with placeholder slots", () => {
    const html = renderMarkdown("value \u00000\u0000 and `code`")
    expect(html).not.toContain("undefined")
    expect(html).toContain("<code>code</code>")
  })

  test("tightens emphasis and identifier underscore rules", () => {
    expect(renderMarkdown("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>")
    expect(renderMarkdown("foo__bar__baz")).toBe("<p>foo__bar__baz</p>")
    expect(renderMarkdown("**a *b* c**")).toBe("<p><strong>a <em>b</em> c</strong></p>")
    expect(renderMarkdown("*x* **y** ~~z~~")).toBe("<p><em>x</em> <strong>y</strong> <del>z</del></p>")
  })

  test("separates mixed ordered/unordered lists and preserves $ replacement patterns in continuations", () => {
    const mixed = renderMarkdown("- one\n1. two")
    expect(mixed).toBe("<ul><li>one</li></ul><ol><li>two</li></ol>")

    const cont = renderMarkdown("- item\n  costs $$5 and matches $& literally")
    expect(cont).toBe("<ul><li>item costs $$5 and matches $&amp; literally</li></ul>")
  })

  test("handles single-line inline backticks, nested fences, and hr after paragraphs", () => {
    expect(renderMarkdown("Use ```foo``` inline")).toBe("<p>Use <code>foo</code> inline</p>")
    expect(renderMarkdown("```foo```")).toBe("<p><code>foo</code></p>")
    expect(renderMarkdown("Use ``a`b`` inline")).toBe("<p>Use <code>a`b</code> inline</p>")

    const nested = renderMarkdown("````md\n```\ncode\n```\n````")
    expect(nested).toBe('<pre><code data-lang="md">```\ncode\n```</code></pre>')

    expect(renderMarkdown("First paragraph\n---")).toBe("<p>First paragraph</p><hr>")
  })

  test("previewBlocks handles CRLF and tilde fences", () => {
    expect(previewBlocks("Intro\r\n\r\n~~~\nignore me\n~~~\r\n- kept")).toEqual({
      text: "Intro",
      bullets: ["kept"],
    })
  })
})
