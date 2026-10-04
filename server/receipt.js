const PDFDocument = require("pdfkit");

function formatAmount(amount) {
    return `NGN ${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 }).format(amount)}`;
}

function streamReceipt(response, order) {
    const document = new PDFDocument({ size: "A4", margin: 52 });
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Content-Disposition", `attachment; filename="fryday-receipt-${order.id}.pdf"`);
    document.pipe(response);

    document.fillColor("#f4512c").fontSize(28).text("fryday.");
    document.moveDown(0.25).fillColor("#171b17").fontSize(16).text("ORDER RECEIPT");
    document.moveDown(0.3).fontSize(10).fillColor("#555555");
    document.text(`Order #${order.id}`);
    document.text(`Placed: ${new Date(order.created_at).toLocaleString("en-NG")}`);
    document.moveDown();

    document.fillColor("#171b17").fontSize(11).text(`Customer: ${order.customer_name}`);
    document.text(`Phone: ${order.phone}`);
    document.text(`Fulfillment: ${order.fulfillment === "delivery" ? "Delivery" : "Pickup"}`);
    if (order.address) document.text(`Delivery address: ${order.address}`);
    document.text(`Payment: ${order.payment_method === "cash_on_delivery" ? "Cash on delivery" : "Cash at pickup"}`);
    if (order.notes) document.text(`Order note: ${order.notes}`);
    document.moveDown();

    document.fontSize(11).fillColor("#f4512c").text("YOUR ORDER");
    document.moveDown(0.4);
    for (const item of order.items) {
        document.fillColor("#171b17").fontSize(10)
            .text(`${item.quantity} x ${item.product_name}`, { continued: true })
            .text(`  ${formatAmount(item.line_total)}`, { align: "right" });
        document.fillColor("#666666").fontSize(9)
            .text(`Food ${formatAmount(item.line_total)}  |  Delivery ${formatAmount(item.delivery_total)}`);
        document.moveDown(0.5);
    }

    document.moveDown(0.5).fillColor("#555555").fontSize(10);
    document.text(`Food subtotal: ${formatAmount(order.subtotal)}`, { align: "right" });
    document.text(`Delivery fees: ${formatAmount(order.delivery_fee)}`, { align: "right" });
    if (order.discount > 0) {
        document.text(`Discount: -${formatAmount(order.discount)}`, { align: "right" });
    }
    document.moveDown(0.3).fillColor("#171b17").fontSize(14)
        .text(`TOTAL: ${formatAmount(order.total)}`, { align: "right" });
    document.moveDown(1.5).fillColor("#777777").fontSize(9)
        .text("Keep this receipt until your order arrives. Payment is due in cash at handoff.", { align: "center" });

    document.end();
}

module.exports = { streamReceipt };