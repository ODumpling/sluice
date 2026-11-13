using System.Text.RegularExpressions;

namespace CoordDemo.Util;

public static partial class Slug
{
    public static string Slugify(string s) => NonAlnum().Replace(s.ToLowerInvariant(), "-");

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NonAlnum();
}
