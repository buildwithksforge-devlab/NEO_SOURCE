import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/front-door/LegalPage";
import { canonicalLink, publicHeadMeta } from "@/lib/route-visibility";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy | NEØ" },
      { name: "description", content: "How NEØ and participating properties handle account, stay and payment information." },
      ...publicHeadMeta("/privacy"),
    ],
    links: [canonicalLink("/privacy")],
  }),
  component: Page,
});

function Page() {
  return (
    <LegalPage title="Privacy Policy">
      <p>NEO Group Africa Technologies Ltd provides NEØ software for hospitality businesses. This policy describes the information used when you visit NEØ, use an account or interact with a property through NEØ.</p>
      <section>
        <h2>Information we handle</h2>
        <p>Depending on what you do, NEØ may handle names and contact details, account and access information, bookings, orders, stay details, messages, payment status and transaction references. The platform also uses technical information such as device and session details and activity logs.</p>
      </section>
      <section>
        <h2>How information is used and shared</h2>
        <p>NEØ uses information to provide the requested service, manage access, support users, reconcile transactions and investigate errors or misuse. Participating properties use the information they receive to operate their businesses and deliver your booking, order or stay. Hosting, messaging and payment providers receive information as needed to perform their services. The payment provider’s privacy terms may also apply.</p>
      </section>
      <section>
        <h2>Cookies and browser storage</h2>
        <p>NEØ uses browser storage for functions such as keeping you signed in and remembering settings. The public home page explains this storage. Clearing site data may sign you out and reset your preferences.</p>
      </section>
      <section>
        <h2>Retention and privacy requests</h2>
        <p>Retention depends on the information, the services you use and applicable accounting, operational and legal requirements. Depending on applicable law, you may ask to access, correct or delete personal information. For a booking, order, stay or property-managed account, contact the property that provided the service or account.</p>
      </section>
      <section>
        <h2>Contact us</h2>
        <p>
          For privacy requests about NEØ, email{" "}
          <a className="break-all font-medium underline underline-offset-4" href="mailto:neogroupafricatechnologies@gmail.com">
            neogroupafricatechnologies@gmail.com
          </a>.
        </p>
      </section>
    </LegalPage>
  );
}
