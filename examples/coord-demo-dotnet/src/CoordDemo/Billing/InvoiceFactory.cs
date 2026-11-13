using CoordDemo.Types;

namespace CoordDemo.Billing;

public static class InvoiceFactory
{
    public static Invoice CreateInvoice(string customerId, long amountCents, string issuedAt) =>
        new() { Id = $"inv_{customerId}_{issuedAt}", CustomerId = customerId, AmountCents = amountCents, IssuedAt = issuedAt };

    public static long TotalCents(IEnumerable<Invoice> invoices) => invoices.Sum(i => i.AmountCents);
}
