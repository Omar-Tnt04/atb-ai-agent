const formatValue = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
};

const formatMoney = (amount, currency) => {
  if (amount === null || amount === undefined || amount === '') return '-';

  const numericAmount = Number(amount);
  const formattedAmount = Number.isFinite(numericAmount)
    ? numericAmount.toLocaleString(undefined, {
        maximumFractionDigits: 3,
      })
    : String(amount);

  return `${formattedAmount}${currency ? ` ${currency}` : ''}`;
};

function ResultLines({ rows }) {
  return (
    <dl className="result-grid">
      {rows
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([label, value]) => (
          <div key={label} className="result-row">
            <dt>{label}:</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function DownloadButton({ url }) {
  if (!url) return null;

  return (
    <a className="result-download-button" href={url} target="_blank" rel="noreferrer">
      Download document
    </a>
  );
}

function CompactResult({ note, rows, downloadUrl }) {
  return (
    <div className="result-card">
      {note ? <p>{note}</p> : null}
      <ResultLines rows={rows} />
      <DownloadButton url={downloadUrl} />
    </div>
  );
}

function ResultCard({ data }) {
  if (!data) return null;

  if (data.account?.balance !== undefined) {
    const account = data.account;

    return (
      <CompactResult
        data={data}
        rows={[
          ['Account', account.accountNumber || account.id],
          ['Balance', formatMoney(account.balance, account.currency)],
          ['Status', account.status],
        ]}
      />
    );
  }

  if (data.document) {
    const document = data.document;

    return (
      <CompactResult data={data} downloadUrl={document.downloadUrl} rows={[]} />
    );
  }

  if (Array.isArray(data.documents)) {
    return (
      <div className="result-card">
        {data.documents.slice(0, 3).map((document) => (
          <div key={document.id || document.documentId || document.title}>
            <p>{formatValue(document.title)} is ready.</p>
            <DownloadButton url={document.downloadUrl} />
          </div>
        ))}
      </div>
    );
  }

  if (data.paymentReference) {
    return (
      <CompactResult
        data={data}
        rows={[
          ['Reference', data.paymentReference],
          ['Amount', formatMoney(data.amount, data.currency)],
          ['Provider', data.provider],
        ]}
      />
    );
  }

  if (data.transferReference) {
    return (
      <CompactResult
        data={data}
        rows={[
          ['Reference', data.transferReference],
          ['Amount', formatMoney(data.amount, data.currency)],
          ['Beneficiary', data.beneficiaryName || data.beneficiaryId],
        ]}
      />
    );
  }

  if (data.complaint) {
    const complaint = data.complaint;

    return (
      <CompactResult
        data={data}
        rows={[
          ['Reference', complaint.reference],
          ['Status', complaint.status],
        ]}
      />
    );
  }

  if (data.appointment) {
    const appointment = data.appointment;

    return (
      <CompactResult
        data={data}
        rows={[
          ['Reference', appointment.appointmentId],
          ['Branch', appointment.branch],
          ['Date', appointment.date],
          ['Time', appointment.time],
        ]}
      />
    );
  }

  return (
    <div className="result-card" />
  );
}

export default ResultCard;
