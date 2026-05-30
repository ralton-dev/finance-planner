export function ProjectsPage() {
  return (
    <section>
      <h1>
        projects <span className="scope">/ all</span>
      </h1>
      <div className="subhead">cross-account groupings of payments toward a shared goal</div>

      <div className="empty-state">
        <h3>not yet implemented</h3>
        <p>
          Projects let you bundle payments across one or more accounts (e.g. a house move) and track
          their aggregate progress. Coming in a later slice — needs a small schema change.
        </p>
        <p>
          For now, payments live on individual accounts. Once <code>core.projects</code> ships,
          you'll be able to group them here.
        </p>
      </div>
    </section>
  );
}
