using CoordDemo.Types;

namespace CoordDemo.Reporting;

public static class Report
{
    public static string RenderReport(IEnumerable<Invoice> invoices) =>
        string.Join("\n", invoices.Select(i => $"{i.Id}\t{(i.AmountCents / 100.0):F2}"));
}
