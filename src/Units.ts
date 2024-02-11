import { IOption, IUnit, IUnitConversion } from "@protoplan/types";
import Graph from 'node-dijkstra';

interface PathList
{
  [node: number]: number | undefined;
}

type SelectUnits = (filters?: { productId?: number, unitId?: number }) => Promise<IUnit[]>;
type SelectDirectConversions = (productId?: number) => Promise<IUnitConversion[]>;

export default class Units
{
  private genericUnits: IUnit[] = [];
  private genericDirectConversions: IUnitConversion[] = [];   // Max 50
  private genericGraph: Graph | undefined = undefined;
  private selectUnits: SelectUnits = () => Promise.resolve([]);
  private selectDirectConversions: SelectDirectConversions = () => Promise.resolve([]);


  constructor(
    selectUnits: SelectUnits,
    selectDirectConversions: SelectDirectConversions)
  {
    this.selectUnits = selectUnits;
    this.selectDirectConversions = selectDirectConversions;
  }

  public async getUnit(unitId: number)
  {
    await this.retrieveGenericUnitsAndConversions();

    let unit = this.genericUnits.find(u => u.unitId === unitId);
    if(!unit)
      unit = (await this.selectUnits({ unitId }))[0];

    return unit ? ({ ...unit }) : undefined;
  }

  public async getUnits(productId?: number)
  {
    await this.retrieveGenericUnitsAndConversions();

    const units = productId ? await this.selectUnits({ productId }) : this.genericUnits;

    return [...units.map(u => ({ ...u }))];
  }

  public async getGenericDirectConversions()
  {
    await this.retrieveGenericUnitsAndConversions();

    return [...this.genericDirectConversions.map(u => ({ ...u }))];
  }

  public async getUnitOption(unitId: number)
  {
    await this.retrieveGenericUnitsAndConversions();

    const unit = this.genericUnits.find(u => u.unitId === unitId) || await this.getUnit(unitId);

    return unit ? ({ label: unit.name, value: unit.unitId }) : undefined;
  }

  // TODO: derive from productNodes and genericGraph nodes where unitId matches form
  public async getUnitOptionsForProduct<T>(product: T & {
    productId: number,
    formId?: number,
    recDoseUnitId?: number,
    amountUnitId: number })
  {
    await this.retrieveGenericUnitsAndConversions();

    const recDoseUnitId = product.recDoseUnitId;
    const amountUnitId = product.amountUnitId;
    const productId = product.productId;
    const formId = product.formId;

    let possibleUnitIds = [amountUnitId];
    if(recDoseUnitId)
      possibleUnitIds.push(recDoseUnitId);

    // Generic units with same form
    if(formId)
      possibleUnitIds.push(...this.genericUnits.filter(u => u.formId === formId).map(u => u.unitId));

    // Product-specific units
    const productUnits = await this.selectUnits({ productId });
    possibleUnitIds.push(...productUnits.map(u => u.unitId));

    // Appearing in product-specific unit conversions
    const ucUnitIds = (await this.selectDirectConversions(productId))
      .map(uc => [uc.fromUnitId, uc.toUnitId]).flat();
    possibleUnitIds.push(...ucUnitIds);

    // Add common small measure volumes if any already exist
    const smalVolumeUnitIds = [2, 13, 30, 31, 33];
    if(!smalVolumeUnitIds.every(value => !possibleUnitIds.includes(value)))
      possibleUnitIds.push(...smalVolumeUnitIds);

    // Remove duplicates
    possibleUnitIds = possibleUnitIds.filter((id, i) => possibleUnitIds.indexOf(id) === i);

    let validUnitOptions: IOption[] = [];
    for(const unitId of possibleUnitIds)
    {
      // Check convertible with amountUnitId;
      const factor = await this.getFactor(unitId, amountUnitId, [productId]);
      if(!factor)
        continue;

      const option = await this.getUnitOption(unitId);
      if(option)
        validUnitOptions.push(option);
    };

    return validUnitOptions.sort((a, b) => a.label.localeCompare(b.label));
  }

  public async getFactor(fromUnitId: number, toUnitId: number, productIds?: number[])
  {
    if(fromUnitId === toUnitId)
      return 1;

    const path = await this.getPath(fromUnitId, toUnitId, productIds);
    if(!path)
      return;

    let factor = 1;

    for(let i = 0; i < path.length - 1; ++i)
    {
      const directFactor = await this.getPreferredDirectFactor(path[i], path[i + 1], productIds);
      if(!directFactor)
      {
        console.error(
          "No direct factor found " +
            "fromUnitId " + path[i] + " " +
            "toUnitId " + path[i + 1] + " " +
            "for productIds " + productIds + ". " +
          "Replacing with 1.");
      }

      factor = factor * (directFactor || 1);
    }

    return factor;
  }

  private async getPath(fromUnitId: number, toUnitId: number, productIds?: number[])
  {
    if(fromUnitId === toUnitId)
      return [];

    const graph = productIds?.length ? await this.buildProductGraph(productIds) : await this.getGenericGraph();

    const path = ((graph.path(fromUnitId.toString(), toUnitId.toString()) || []) as string[])
      .map(id => Number(id));

    if(productIds && productIds[0] === 24515)
      console.log("path", path);

    if(path.length < 2)
      return;

    return path;
  }

  private async getGenericGraph()
  {
    return this.genericGraph || await this.buildGenericGraph();
  }

  private async buildProductGraph(productIds: number[])
  {
    await this.retrieveGenericUnitsAndConversions();

    const productUnitConversions = (await Promise.all(productIds
      .map(async id => await this.selectDirectConversions(id)))).flat();

    const graph = new Graph;

    const units = this.genericUnits;

    const fromUnitIds = units.map(u => u.unitId);
    const productUcFromUnitIds = productUnitConversions.map(uc => uc.fromUnitId);
    let uniqueFromUnitIds = fromUnitIds.concat(productUcFromUnitIds);
    uniqueFromUnitIds = uniqueFromUnitIds.filter((id, i) => i === uniqueFromUnitIds.indexOf(id));

    const toUnitIds = units.map(u => u.unitId);
    const productUcToUnitIds = productUnitConversions.map(uc => uc.toUnitId);
    let uniqueToUnitIds = toUnitIds.concat(productUcToUnitIds);
    uniqueToUnitIds = uniqueToUnitIds.filter((id, i) => i === uniqueToUnitIds.indexOf(id));

    for(const fromUnitId of uniqueFromUnitIds)
    {
      const nodePaths: PathList = {};

      for(const toUnitId of uniqueToUnitIds)
      {
        const ucFactor = productUnitConversions
          .find(uc => uc.fromUnitId === fromUnitId && uc.toUnitId === toUnitId)?.factor;

        const factor = ucFactor || await this.getPreferredDirectFactor(fromUnitId, toUnitId);

        if(factor)
          nodePaths[toUnitId] = factor;
      };

      graph.addNode(fromUnitId.toString(), nodePaths);
    };

    if(productIds[0] === 24515)
      console.log("graph", graph);

    return graph;
  }

  private async buildGenericGraph()
  {
    await this.retrieveGenericUnitsAndConversions();

    const graph = new Graph;

    const units = this.genericUnits;

    for(const fromUnit of units)
    {
      const nodePaths: PathList = {};

      for(const toUnit of units)
      {
        const factor = await this.getPreferredDirectFactor(fromUnit.unitId, toUnit.unitId);

        if(factor)
          nodePaths[toUnit.unitId] = factor;
      };

      graph.addNode(fromUnit.unitId.toString(), nodePaths);
    };

    return graph;
  }

  private async retrieveGenericUnitsAndConversions()
  {
    if(!this.genericUnits.length)
      this.genericUnits = await this.selectUnits();

    if(!this.genericDirectConversions.length)
      this.genericDirectConversions = await this.selectDirectConversions();
  }

  private async getPreferredDirectFactor(fromUnitId: number, toUnitId: number, productIds?: number[])
  {
    if(fromUnitId === toUnitId)
      return 1;

    let factor = await this.getDirectFactor(fromUnitId, toUnitId, productIds);
    if(factor)
      return factor;

    // Unit conversions of fallback generic units with matching name
    const fromUnit = await this.getUnit(fromUnitId);
    const toUnit = await this.getUnit(toUnitId);
    const genericFromUnit = this.genericUnits.find(u => !u.productId && u.name === fromUnit?.name);
    const genericToUnit = this.genericUnits.find(u => !u.productId && u.name === toUnit?.name);
    const genericFactor = await this.getDirectFactor(
      genericFromUnit?.unitId || fromUnitId,
      genericToUnit?.unitId || toUnitId);

    return genericFactor;
  };

  private async getDirectFactor(fromUnitId: number, toUnitId: number, productIds?: number[])
  {
    if(fromUnitId === toUnitId)
      return 1;

    const productUnitConversions = productIds ? (await Promise.all(productIds
      .map(async id => await this.selectDirectConversions(id)))).flat() : [];

    for(const uc of productUnitConversions.concat(this.genericDirectConversions))
    {
      const factor = factorIfConversionMatches(uc, fromUnitId, toUnitId);
      if(factor)
        return Number(factor);
    }
  };

}



// Returns the unit conversion factor if the conversion matches the to/fromUnits
function factorIfConversionMatches(
  conversion: { fromUnitId: number, toUnitId: number, factor: number },
  fromUnitId: number,
  toUnitId: number)
{
  const from = conversion.fromUnitId;
  const to = conversion.toUnitId;
  const factor = conversion.factor;

  if(fromUnitId === from && toUnitId === to)
    return factor;
  else if(toUnitId === from && fromUnitId === to)
    return 1.0 / factor;
  else
    return;
}


