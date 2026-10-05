export function grounded(number: string, blob: string): boolean {
  if (blob.includes(number)) return true;
  const runs = number.match(/\d{5,}/g) ?? [];
  return runs.length > 0 && runs.every((run) => blob.includes(run));
}

/** Trimmed from the USPTO Open Data Portal search example for patent 12000000. */
export const usptoSample = {
  count: 1,
  patentFileWrapperDataBag: [
    {
      applicationNumberText: "18045436",
      grantDocumentMetaData: {
        fileLocationURI: "https://api.uspto.gov/api/v1/datasets/products/files/PTGRXML-SPLT/2024/ipg240604/18045436_12000000.xml"
      },
      applicationMetaData: {
        filingDate: "2022-10-10",
        cpcClassificationBag: ["C07H19/207", "C12Q1/6869"],
        inventorBag: [{ inventorNameText: "Lubomir SEBO" }, { inventorNameText: "Gene SHEN" }],
        applicationStatusDescriptionText: "Patented Case",
        patentNumber: "12000000",
        grantDate: "2024-06-04",
        applicantBag: [{ applicantNameText: "Pacific Biosciences of California, Inc." }],
        earliestPublicationNumber: "US20230366018A1",
        inventionTitle: "LABELED NUCLEOTIDE ANALOGS, REACTION MIXTURES, AND METHODS AND SYSTEMS FOR SEQUENCING"
      },
      parentContinuityBag: [
        { parentPatentNumber: "11466319", parentApplicationNumberText: "17006669", claimParentageTypeCodeDescriptionText: "is a Continuation of" },
        { parentPatentNumber: "10781483", parentApplicationNumberText: "15357966", claimParentageTypeCodeDescriptionText: "is a Continuation of" }
      ]
    }
  ]
};
