import { describe, expect, test } from "bun:test"
import {
  compactPath,
  expandPath,
  isRootPath,
  joinDir,
  looksLikePath,
  parentDir,
  pathSep,
  splitFolderLookup,
} from "../src/app/picker"

describe("picker path helpers", () => {
  test("looksLikePath recognizes POSIX, Windows, home, and relative paths", () => {
    expect(looksLikePath("/Users/you")).toBe(true)
    expect(looksLikePath("~")).toBe(true)
    expect(looksLikePath("~/code")).toBe(true)
    expect(looksLikePath("~\\code")).toBe(true)
    expect(looksLikePath("C:\\Users\\torre")).toBe(true)
    expect(looksLikePath("D:/work/app")).toBe(true)
    expect(looksLikePath("\\\\server\\share")).toBe(true)
    expect(looksLikePath("./app")).toBe(true)
    expect(looksLikePath("..\\app")).toBe(true)
    expect(looksLikePath("~user")).toBe(false)
    expect(looksLikePath("my-project")).toBe(false)
  })

  test("isRootPath and pathSep handle POSIX and Windows roots", () => {
    expect(isRootPath("/")).toBe(true)
    expect(isRootPath("\\")).toBe(true)
    expect(isRootPath("C:\\")).toBe(true)
    expect(isRootPath("C:/")).toBe(true)
    expect(isRootPath("C:\\Users")).toBe(false)
    expect(pathSep("C:\\Users\\torre")).toBe("\\")
    expect(pathSep("/Users/you")).toBe("/")
    expect(pathSep("folder", "C:\\Users\\torre")).toBe("\\")
    expect(pathSep("folder", "/Users/you")).toBe("/")
  })

  test("expandPath and compactPath handle POSIX, Windows, and prefix-collision boundaries", () => {
    expect(expandPath("~", "/Users/you")).toBe("/Users/you")
    expect(expandPath("~/code/app", "/Users/you")).toBe("/Users/you/code/app")
    expect(expandPath("~/code/app", "C:\\Users\\torre")).toBe("C:\\Users\\torre\\code\\app")
    expect(expandPath("~\\code\\app", "C:\\Users\\torre\\")).toBe("C:\\Users\\torre\\code\\app")
    expect(expandPath("~/work", "D:\\")).toBe("D:\\work")

    expect(compactPath("/Users/you", "/Users/you")).toBe("~")
    expect(compactPath("/Users/you/code", "/Users/you")).toBe("~/code")
    // Must not falsely collapse sibling usernames that merely share a prefix.
    expect(compactPath("/Users/you2/code", "/Users/you")).toBe("/Users/you2/code")
    // Case-insensitive match and slash normalization on Windows.
    expect(compactPath("c:\\users\\torre\\repo", "C:\\Users\\torre")).toBe("~/repo")
    expect(compactPath("C:\\Users\\torre", "C:\\Users\\torre")).toBe("~")
    expect(compactPath("D:\\other", "C:\\Users\\torre")).toBe("D:\\other")
  })

  test("parentDir and joinDir handle roots and separators cleanly", () => {
    expect(parentDir("/")).toBe("/")
    expect(parentDir("/code/app/")).toBe("/code")
    expect(parentDir("/code")).toBe("/")
    expect(parentDir("C:\\")).toBe("C:\\")
    expect(parentDir("C:\\Users\\torre\\")).toBe("C:\\Users")
    expect(parentDir("C:\\Users")).toBe("C:\\")

    expect(joinDir("/", "tmp")).toBe("/tmp")
    expect(joinDir("/code", "app")).toBe("/code/app")
    expect(joinDir("C:\\", "Users")).toBe("C:\\Users")
    expect(joinDir("C:\\Users\\", "torre")).toBe("C:\\Users\\torre")
  })

  test("splitFolderLookup parses POSIX and Windows paths with and without trailing separators", () => {
    expect(splitFolderLookup("/code/ap")).toEqual({
      trailing: false,
      exact: "/code/ap",
      parent: "/code",
      leafName: "ap",
      leaf: "ap",
      base: "/code",
      isExactRoot: false,
    })
    expect(splitFolderLookup("C:\\")).toEqual({
      trailing: true,
      exact: "C:\\",
      parent: "C:\\",
      leafName: "",
      leaf: "",
      base: "C:\\",
      isExactRoot: true,
    })
    expect(splitFolderLookup("C:\\Users\\Tor")).toEqual({
      trailing: false,
      exact: "C:\\Users\\Tor",
      parent: "C:\\Users",
      leafName: "Tor",
      leaf: "tor",
      base: "C:\\Users",
      isExactRoot: false,
    })
  })
})
