import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateSubscriptionInvoicePdf,
  renderSubscriptionInvoice,
  type SubscriptionInvoiceData,
} from "../src/index.ts";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, "..");
const templatePath = path.join(
  packageRoot,
  "src",
  "templates",
  "subscription-invoice.hbs",
);
const outputDir = path.join(packageRoot, "tests", "output");

type InvoiceFixtureOverrides = {
  invoice?: Partial<SubscriptionInvoiceData["invoice"]>;
  subscription?: Partial<SubscriptionInvoiceData["subscription"]>;
  plan?: Partial<SubscriptionInvoiceData["plan"]>;
  platform?: Partial<SubscriptionInvoiceData["platform"]>;
  subscriber?: Partial<NonNullable<SubscriptionInvoiceData["subscriber"]>>;
  locale?: SubscriptionInvoiceData["locale"];
};

function createInvoiceData(
  id: string,
  status: SubscriptionInvoiceData["invoice"]["status"],
  overrides: InvoiceFixtureOverrides = {},
): SubscriptionInvoiceData {
  const issueDate = new Date("2026-05-06T09:00:00.000Z");
  const dueDate = new Date("2026-05-10T09:00:00.000Z");
  const paidAt = status === "paid" ? new Date("2026-05-06T11:15:00.000Z") : null;

  const baseData: SubscriptionInvoiceData = {
    invoice: {
      id,
      subscriptionId: "sub_demo_001",
      subscriberId: "tenant_demo_001",
      amount: 249,
      currency: "SAR",
      status,
      gatewayInvoiceId: `gateway_${id}`,
      paidAt,
      dueDate,
      lineItems: [
        {
          description: "خطة الاحتراف الشهرية",
          quantity: 1,
          unitPrice: 199,
          amount: 199,
        },
        {
          description: "إضافة أعضاء الفريق",
          quantity: 2,
          unitPrice: 25,
          amount: 50,
        },
      ],
      metadata: {
        notes:
          status === "paid"
            ? "تم استلام الدفعة بنجاح. شكراً لاستخدامكم الخدمة."
            : "يرجى سداد الفاتورة قبل تاريخ الاستحقاق لتجنب انقطاع الخدمة.",
      },
      createdAt: issueDate,
      updatedAt: issueDate,
    },
    subscription: {
      id: "sub_demo_001",
      status: status === "paid" ? "active" : "past_due",
      currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2026-05-31T23:59:59.000Z"),
      subscriberId: "tenant_demo_001",
    },
    plan: {
      name: "الخطة الاحترافية",
      description: "وصول كامل إلى الأدوات الأساسية مع دعم قياسي وتقارير شهرية.",
      price: 199,
      currency: "SAR",
      interval: "monthly",
      intervalCount: 1,
    },
    platform: {
      name: "منهالي",
      website: "https://manhali.com",
      supportEmail: "billing@manhali.com",
      address: "الرياض، المملكة العربية السعودية",
    },
    subscriber: {
      name: "أكاديمية الاختبار",
      email: "finance@example.com",
      phone: "+966500000000",
      address: "حي النرجس، الرياض",
    },
    locale: "ar-SA",
  };

  return {
    ...baseData,
    ...overrides,
    invoice: {
      ...baseData.invoice,
      ...overrides.invoice,
    },
    subscription: {
      ...baseData.subscription,
      ...overrides.subscription,
    },
    plan: {
      ...baseData.plan,
      ...overrides.plan,
    },
    platform: {
      ...baseData.platform,
      ...overrides.platform,
    },
    subscriber: {
      ...baseData.subscriber,
      ...overrides.subscriber,
    },
  };
}

async function writeHtmlInvoice(
  fileName: string,
  data: SubscriptionInvoiceData,
): Promise<void> {
  const html = await renderSubscriptionInvoice(templatePath, data);
  await writeFile(path.join(outputDir, fileName), html, "utf8");
}

async function writePdfInvoice(
  fileName: string,
  data: SubscriptionInvoiceData,
): Promise<void> {
  const pdf = await generateSubscriptionInvoicePdf(templatePath, data);
  await writeFile(path.join(outputDir, fileName), pdf);
}

async function main(): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const fixtures: Array<{ name: string; data: SubscriptionInvoiceData }> = [
    {
      name: "invoice-paid",
      data: createInvoiceData("inv_paid_001", "paid"),
    },
    {
      name: "invoice-open",
      data: createInvoiceData("inv_open_001", "open"),
    },
    {
      name: "invoice-draft",
      data: createInvoiceData("inv_draft_001", "draft", {
        invoice: {
          dueDate: null,
          gatewayInvoiceId: null,
          metadata: {
            notes: "هذه نسخة مراجعة داخلية قبل إرسال الفاتورة للعميل.",
          },
        },
        subscription: {
          status: "trialing",
        },
      }),
    },
  ];

  for (const fixture of fixtures) {
    await writeHtmlInvoice(`${fixture.name}.html`, fixture.data);
  }

  if (process.env.GENERATE_PDF === "1") {
    for (const fixture of fixtures) {
      await writePdfInvoice(`${fixture.name}.pdf`, fixture.data);
    }
  }

  console.log(`Generated ${fixtures.length} HTML test invoices in ${outputDir}`);

  if (process.env.GENERATE_PDF === "1") {
    console.log(`Generated ${fixtures.length} PDF test invoices in ${outputDir}`);
  } else {
    console.log("Set GENERATE_PDF=1 to generate PDF files as well.");
  }
}

await main();