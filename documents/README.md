# ProtPocket

**From protein name to ranked drug binding sites — automated, in seconds.**

ProtPocket is an open-source computational drug discovery tool that takes a protein name, gene symbol, disease, or UniProt accession as input and returns a complete structural analysis: real-time complex data from AlphaFold, drug target prioritization via an original Gap Score algorithm, interactive 3D structure comparison, automated binding site detection using fpocket, and fragment molecule suggestions from ChEMBL — all in one browser-based workflow.

It was built on top of the AlphaFold homodimer dataset released March 16, 2026 by EMBL-EBI, Google DeepMind, NVIDIA, and Seoul National University — the largest protein complex dataset ever assembled. ProtPocket is, to our knowledge, the first tool to make this dataset queryable by drug discovery priority through a live API pipeline.

---

## Table of Contents

1. [The Problem](#the-problem)
2. [How ProtPocket Works](#how-protpocket-works)
3. [Technical Discovery: The AlphaFold Complex API](#technical-discovery)
4. [The Gap Score](#the-gap-score)
5. [Binding Site Detection](#binding-site-detection)
6. [Data Sources](#data-sources)
7. [Architecture](#architecture)
8. [Installation](#installation)
9. [API Reference](#api-reference)
10. [Roadmap](#roadmap)

---

## The Problem

Protein structures have been the foundation of rational drug design for decades. When researchers know the three-dimensional shape of a protein involved in disease, they can in principle design a molecule that fits into a cavity on its surface and disrupts its function. The challenge has always been bridging the gap between having a structure and knowing where and how to target it.

The traditional workflow is brutally fragmented. A researcher investigating a tuberculosis protein today must query AlphaFold manually for the structure, visit UniProt separately for disease context, run ChEMBL queries independently for drug coverage, download structure files locally, run pocket detection software from a command line, and then consult fragment databases with another tool entirely. Each step requires a different interface, produces output in a different format, and demands familiarity with a different tool. Most researchers do not have access to expensive commercial suites — Schrödinger, MOE, Discovery Studio — that partially unify these workflows. Even those who do still face the deeper problem that most of these tools operate on monomer structures.

A monomer is a single protein chain in isolation. A homodimer is two identical chains bound together. The biological reality is that most proteins only execute their functional role as dimers or larger complexes — the monomer form exists as a folding intermediate or transport state, not the active species inside the cell. The interface between two chains when they come together creates surface cavities — pockets — that do not exist in either chain alone. These interface pockets are among the most valuable drug targets in modern pharmacology, the basis of protein-protein interaction (PPI) inhibitor programs. Yet they are invisible to any tool that analyzes monomers only.

The March 2026 AlphaFold homodimer release changed the availability of complex structural data fundamentally. But it provided no tooling to query the data by drug discovery priority, no way to run pocket analysis on the new structures programmatically, and no connection to fragment databases. The dataset existed but was not actionable.

---

## How ProtPocket Works

### Query Classification and Multi-Database Retrieval

When a researcher submits a query — whether it is a gene name like `TP53`, a disease term like `tuberculosis`, a UniProt accession like `P04637`, or an AlphaFold ID like `AF-0000000066503175` — ProtPocket first classifies the query type. A UniProt accession goes directly to AlphaFold without a search step. A gene name hits UniProt with a gene-exact filter. A disease term queries UniProt's disease annotation index. An AlphaFold ID bypasses both and resolves immediately.

For each matching protein, ProtPocket fires three concurrent requests: to AlphaFold for both monomer and homodimer predictions, to ChEMBL for approved drug coverage, and to UniProt for disease associations and organism context. These run in parallel via Go goroutines and merge before the response is returned.

### Disorder Delta and Structural Comparison

For every protein, ProtPocket computes the disorder delta — the difference in average pLDDT confidence between the monomer and homodimer AlphaFold predictions. This single number captures the structural reveal: how much the protein gains in ordered, confident structure when it finds its binding partner. A disorder delta of +36 means the protein went from 50% structural confidence in isolation to 86% confidence in complex form — the functional shape was completely hidden in the monomer and emerged only in the dimer.

The detail page renders both structures in the Mol* 3D viewer, colored by per-residue pLDDT confidence. Blue regions are predicted with high confidence; red and orange regions are disordered.

<img src="./public/img/Q55DI5.png" alt="Q55DI5" />

### Gap Score Ranking

Every protein in the results is ranked by an original Gap Score that answers the question: how urgently does the world need a drug for this target? The score combines structural confidence, drug coverage from ChEMBL, WHO priority pathogen status, and the disorder delta bonus. Results are sorted descending — the most urgently undrugged, high-confidence target appears first. The undrugged targets dashboard provides a pre-ranked leaderboard of the highest Gap Score complexes across the 20 most studied species.
<img src="./public/img/ranking.png" alt="Ranking" />

### Binding Site Detection with fpocket

When a researcher requests pocket analysis for a specific complex, ProtPocket runs fpocket on both the monomer and the homodimer structure files. fpocket identifies surface cavities using Voronoi tessellation and alpha sphere algorithms, returning each pocket with a druggability score, volume in cubic Ångströms, and the residues lining it.
<img src="./public/img/comparison.png" alt="Comparison" />

By comparing the pocket lists from the monomer and dimer runs, ProtPocket identifies interface pockets — cavities that appear in the dimer but have no corresponding cavity in the monomer. These are pockets formed specifically by the coming together of two chains. They are cross-validated against the per-residue disorder delta: pockets lined by residues that gained structural confidence in the dimer are flagged as high-confidence interface pockets, the primary targets for PPI inhibitor programs.
<img src="./public/img/pocket-analysis.png" alt="Pocket Analysis" />

### Fragment Suggestion from ChEMBL

For each identified pocket, ProtPocket queries ChEMBL for small molecule fragments whose known binding pockets share geometric properties with the identified cavity — similar volume, similar hydrophobicity profile, similar charge distribution. The returned fragments are molecules that have been shown experimentally to bind structurally similar pockets in other proteins, providing a starting point for medicinal chemistry rather than an empty search space.
<img src="./public/img/fragments.png" alt="Fragments" />

### Live Structure Docking (AutoDock Vina)

Once fragments are suggested, the researcher can validate their fit directly in the browser via an integrated docking service powered by **AutoDock Vina** and **Open Babel**. Upon selecting a ChEMBL fragment, the backend:
1. Converts the 1D SMILES string into a 3D ligand conformation using Open Babel.
2. Prepares the AlphaFold receptor by converting it to the required PDBQT format.
3. Automatically sets the docking search space bounding box explicitely over the fpocket-derived center of the cavity.
4. Executes Vina in the background to calculate binding affinities.

The results are asynchronously streamed back to the frontend. Binding affinity scores (in kcal/mol) and docked poses are displayed in the leaderboard:
<img src="./public/img/dock-lead.png" alt="Docking Leaderboard" />

In parallel, the resulting 3D ligand structures are loaded directly into the Mol* viewer to visually represent how the molecule is embedded within the pocket:
<img src="./public/img/dock.png" alt="Docking Viewer" />

---

## The Gap Score

The Gap Score is ProtPocket's original drug target prioritization algorithm. It answers one question: given everything known about this protein complex, how urgently does research need a drug for it?

```
Gap Score = pLDDT_norm × undrugged_factor × WHO_multiplier + disorder_bonus
```

**`pLDDT_norm`** is the AlphaFold dimer confidence score normalized to 0–1. A structurally unreliable prediction should not drive expensive drug discovery programs — this term ensures only well-predicted targets rank highly.

**`undrugged_factor`** is `1 - (drug_count / max_drug_count_in_dataset)`. When no approved drug targets the protein, this equals 1.0. As drug coverage increases the factor approaches 0, pushing well-covered targets to the bottom. This is the gap the algorithm is named for.

**`WHO_multiplier`** applies a hard 2.0× boost to proteins from WHO priority pathogens — the 19 bacteria and viruses the World Health Organization has designated as critical antimicrobial resistance threats. This reflects real-world clinical urgency.

**`disorder_bonus`** adds `disorder_delta / 100` when the delta is positive. Proteins that undergo dramatic structural transformation in complex form represent the most scientifically novel entries in the March 2026 dataset. The bonus rewards them proportionally.

---

## Binding Site Detection

ProtPocket's pocket analysis pipeline operates on monomer and homodimer structure files and identifies druggable cavities through three stages.

In the first stage, fpocket is invoked as a subprocess on both the monomer and dimer cif files. fpocket uses a rolling sphere algorithm — a probe sphere of variable radius is rolled across the molecular surface, and positions where the sphere is significantly surrounded by protein atoms are identified as potential pockets. Each pocket is scored for druggability based on its volume, shape, and chemical environment.

In the second stage, the monomer and dimer pocket lists are compared geometrically. A pocket in the dimer that has no corresponding cavity within threshold distance in the monomer is identified as an interface pocket — it was created by the structural change induced by dimerization. Interface pockets are the primary targets of PPI inhibitor programs because a molecule binding there disrupts the protein-protein interaction itself rather than blocking a conventional enzymatic active site.

In the third stage, each interface pocket is cross-referenced with per-residue pLDDT data from AlphaFold's confidence JSON files. Pockets whose lining residues gained the most structural confidence in the dimer — those with per-residue delta above threshold — are flagged as high-confidence interface pockets and sorted to the top of the ranked list.

The Mol* viewer on the detail page highlights the identified pocket residues directly on the structure, allowing the researcher to visually inspect the cavity geometry and its relationship to the structural reveal.

---

## Data Sources

**AlphaFold Database** (EMBL-EBI and Google DeepMind) provides all protein structure predictions. ProtPocket queries the search endpoint live for every request, recovering both monomer and homodimer predictions in a single call. 

**UniProt** provides protein identity — gene names, organism, taxonomy ID, disease associations, and reviewed annotation status. Every protein in ProtPocket has a UniProt accession as its canonical identifier, and all cross-database lookups originate from it.

**ChEMBL** (EMBL-EBI) provides drug-target association data. ProtPocket queries ChEMBL for approved drugs at Phase 4 clinical status and above targeting each protein. The resulting drug count feeds directly into the undrugged factor of the Gap Score. ChEMBL is also queried for fragment molecule suggestions matched to identified pocket geometries.

**WHO Priority Pathogen List** (2024 edition) is hardcoded as a lookup table keyed by NCBI taxonomy ID. The list covers 24 bacterial and fungal pathogens designated as critical antimicrobial resistance threats and drives the 2× multiplier in the Gap Score.

**fpocket** runs locally as a subprocess. No external API is involved — structure files are downloaded, converted, analyzed, and the temporary files are deleted. fpocket is MIT licensed and freely available.

**AutoDock Vina** runs locally as a subprocess to process ligand binding simulations, calculating affinity values and generating 3D molecular poses explicitly mapped into the target pockets.

**Open Babel** handles all molecular format conversions between stages — CIF to PDB for fpocket input, SMILES to 3D for ligand preparation, and format interconversion for fragment structures.

ProtPocket does not store or redistribute AlphaFold structure files. All structure data is linked directly to EMBL-EBI's servers. All primary data sources are freely available under open licenses compatible with academic and commercial use.

---

## Citation

If you use ProtPocket in research, please cite the AlphaFold Database and the March 2026 complex release:

> Fleming J. et al. AlphaFold Protein Structure Database and 3D-Beacons: New Data and Capabilities. *Journal of Molecular Biology* (2025).

> EMBL-EBI, Google DeepMind, NVIDIA, Seoul National University. Millions of protein complexes added to AlphaFold Database. March 16, 2026. https://www.embl.org/news/science-technology/first-complexes-alphafold-database/

The technical discovery of the AlphaFold complex API pipeline is documented in [COMPLEX.md](./COMPLEX.md) and may be cited independently.

---
