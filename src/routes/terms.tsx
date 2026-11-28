import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage } from "@/components/front-door/LegalPage";
import { canonicalLink, publicHeadMeta } from "@/lib/route-visibility";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms and Conditions | NEØ" },
      { name: "description", content: "The conditions for using the NEØ platform and services offered by participating properties." },
      ...publicHeadMeta("/terms"),
    ],
    links: [canonicalLink("/terms")],
  }),
  component: Page,
});

function Page() {
  return (
    <LegalPage title="Terms and Conditions">
      <p>These terms cover use of the NEØ hospitality platform operated by NEO Group Africa Technologies Ltd. Separate terms may apply to a property’s services or to an organisation’s subscription.</p>
      <section>
        <h2>Accounts and access</h2>
        <p>Provide accurate information, keep your credentials secure and use the accounts and permissions assigned to you. If you create a workspace for an organisation, you must have authority to act for it. Let your workspace administrator know if you suspect unauthorised use.</p>
      </section>
      <section>
        <h2>Bookings, orders and payments</h2>
        <p>Participating properties provide the stays, food and other services listed through NEØ. Review the property’s prices, cancellation terms and refund rules before you confirm. Send questions about a booking, charge or refund to the property that took the booking or order.</p>
      </section>
      <section>
        <h2>Acceptable use</h2>
        <p>Use NEØ lawfully. Do not access another person’s records without permission, submit deceptive information, disrupt the platform or use workspace data for an unauthorised purpose. Workspace administrators are responsible for managing their users’ access.</p>
      </section>
      <section>
        <h2>Privacy and contact</h2>
        <p>
          Read the <Link to="/privacy" className="font-medium underline underline-offset-4">Privacy Policy</Link>
          {" "}for information about how NEØ handles personal information. For questions about these terms, email{" "}
          <a className="break-all font-medium underline underline-offset-4" href="mailto:neogroupafricatechnologies@gmail.com">
            neogroupafricatechnologies@gmail.com
          </a>.
        </p>
      </section>
    </LegalPage>
  );
}
