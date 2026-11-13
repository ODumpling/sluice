namespace CoordDemo.Types;

/// <summary>An invoice as stored and exchanged between modules.</summary>
public sealed class Invoice
{
    public required string Id { get; init; }
    public required string CustomerId { get; init; }
    public long AmountCents { get; init; }
    public required string IssuedAt { get; init; }
}

public enum InvoiceStatus
{
    Draft,
    Open,
    Paid,
}
